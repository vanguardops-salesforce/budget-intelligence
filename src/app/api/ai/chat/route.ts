import { NextResponse } from 'next/server';
import { z } from 'zod';
import { createServerSupabaseClient } from '@/lib/supabase/server';
import { requireMFA } from '@/lib/supabase/auth-config';
import { toClientError, ValidationError } from '@/lib/errors';
import { checkRateLimit, RATE_LIMITS } from '@/lib/rate-limit';
import { getClientIP, writeAuditLog } from '@/lib/audit';
import { logger } from '@/lib/logger';
import { getOpenAIClient } from '@/lib/ai/client';
import { SYSTEM_PROMPT, DISCLAIMER } from '@/lib/ai/prompts';
import { AI_FUNCTIONS, executeFunction, type FunctionName } from '@/lib/ai/functions';
import type OpenAI from 'openai';

const MAX_FUNCTION_ROUNDS = 5;

const requestSchema = z.object({
  conversation_id: z.string().uuid().optional(),
  message: z.string().min(1).max(2000),
});

export async function POST(request: Request) {
  try {
    const supabase = createServerSupabaseClient();
    const { data: { user } } = await supabase.auth.getUser();

    if (!user) {
      return NextResponse.json({ error: 'Authentication required.' }, { status: 401 });
    }

    await requireMFA(supabase);

    // Rate limit: 10 req/min
    const rateCheck = checkRateLimit(RATE_LIMITS.AI_CHAT, user.id);
    if (!rateCheck.allowed) {
      return NextResponse.json(
        { error: 'Too many requests. Please wait a moment.' },
        { status: 429, headers: { 'Retry-After': String(Math.ceil((rateCheck.resetAt - Date.now()) / 1000)) } }
      );
    }

    const body = await request.json();
    const parsed = requestSchema.safeParse(body);
    if (!parsed.success) {
      throw new ValidationError('Invalid request body');
    }

    const { message, conversation_id } = parsed.data;
    const ip = getClientIP(request.headers) ?? 'unknown';

    // --- Conversation management ---
    let conversationId = conversation_id;
    let isNewConversation = false;

    if (!conversationId) {
      // Create new conversation
      const { data: conv, error: convErr } = await supabase
        .from('ai_conversations')
        .insert({
          user_id: user.id,
          title: message.slice(0, 100),
          message_count: 0,
          purge_after: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
        })
        .select('id')
        .single();

      if (convErr || !conv) {
        logger.error('Failed to create conversation', { error_message: convErr?.message });
        throw new Error('Failed to create conversation');
      }

      conversationId = conv.id;
      isNewConversation = true;

      // Audit: AI_SESSION_STARTED
      await writeAuditLog(supabase, {
        userId: user.id,
        action: 'AI_SESSION_STARTED',
        entityType: 'ai_conversation',
        entityId: conversationId,
        ipAddress: ip,
      });
    } else {
      // Verify conversation belongs to user
      const { data: existing } = await supabase
        .from('ai_conversations')
        .select('id')
        .eq('id', conversationId)
        .eq('user_id', user.id)
        .single();

      if (!existing) {
        throw new ValidationError('Conversation not found');
      }
    }

    // --- Store user message ---
    await supabase.from('ai_messages').insert({
      conversation_id: conversationId,
      role: 'user',
      content: message,
    });

    // --- Build message history from DB (summaries, not raw payloads) ---
    const { data: history } = await supabase
      .from('ai_messages')
      .select('role, content')
      .eq('conversation_id', conversationId)
      .order('created_at', { ascending: true })
      .limit(20); // Last 20 messages for context

    const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
      { role: 'system', content: SYSTEM_PROMPT },
    ];

    // Add conversation history
    for (const msg of (history ?? [])) {
      if (msg.role === 'user' || msg.role === 'assistant') {
        messages.push({ role: msg.role, content: msg.content });
      }
    }

    // --- OpenAI completion with function calling loop ---
    const openai = getOpenAIClient();
    const functionCallsLog: string[] = [];
    let assistantContent = '';

    for (let round = 0; round < MAX_FUNCTION_ROUNDS; round++) {
      const completion = await openai.chat.completions.create({
        model: 'gpt-4o',
        messages,
        tools: AI_FUNCTIONS,
        tool_choice: round === 0 ? 'auto' : 'auto',
        temperature: 0.7,
        max_tokens: 1500,
        stream: false,
      });

      const choice = completion.choices[0];
      if (!choice) break;

      const responseMessage = choice.message;

      // If the model wants to call functions
      if (responseMessage.tool_calls && responseMessage.tool_calls.length > 0) {
        // Add assistant message with tool calls to history
        messages.push(responseMessage);

        // Execute each function call
        for (const toolCall of responseMessage.tool_calls) {
          const fnName = toolCall.function.name as FunctionName;
          const fnArgs = JSON.parse(toolCall.function.arguments || '{}');

          // Audit: AI_FUNCTION_CALLED (function name only, NOT the data)
          functionCallsLog.push(fnName);
          await writeAuditLog(supabase, {
            userId: user.id,
            action: 'AI_FUNCTION_CALLED',
            entityType: 'ai_conversation',
            entityId: conversationId,
            details: { function_name: fnName },
            ipAddress: ip,
          });

          const result = await executeFunction(fnName, fnArgs, supabase, user.id);

          messages.push({
            role: 'tool',
            tool_call_id: toolCall.id,
            content: result,
          });
        }

        // Continue the loop to get the model's final response
        continue;
      }

      // Model returned a text response — we're done
      assistantContent = responseMessage.content || '';
      break;
    }

    // --- Inject disclaimer if not already present ---
    if (!assistantContent.includes(DISCLAIMER)) {
      assistantContent += `\n\n*${DISCLAIMER}*`;
    }

    // --- Store assistant message (summary, not raw function payloads) ---
    await supabase.from('ai_messages').insert({
      conversation_id: conversationId,
      role: 'assistant',
      content: assistantContent,
      function_calls: functionCallsLog.length > 0
        ? functionCallsLog.map((name) => ({ function_name: name }))
        : null,
    });

    // --- Update conversation metadata ---
    await supabase
      .from('ai_conversations')
      .update({
        message_count: (history?.length ?? 0) + 1,
        last_message_at: new Date().toISOString(),
        // Store summary, not raw data
        summary: isNewConversation ? message.slice(0, 200) : undefined,
      })
      .eq('id', conversationId);

    return NextResponse.json({
      conversation_id: conversationId,
      message: assistantContent,
    });
  } catch (error) {
    logger.error('AI chat error', { error_message: String(error) });
    const clientError = toClientError(error);
    return NextResponse.json({ error: clientError.error }, { status: clientError.status });
  }
}
