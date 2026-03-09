import { NextResponse } from 'next/server';
import { createServerSupabaseClient } from '@/lib/supabase/server';
import { requireMFA } from '@/lib/supabase/auth-config';
import { toClientError } from '@/lib/errors';
import { checkRateLimit, RATE_LIMITS } from '@/lib/rate-limit';
import { getClientIP, writeAuditLog } from '@/lib/audit';
import { logger } from '@/lib/logger';
import { getOpenAIClient, AI_MODEL, AI_MAX_TOKENS } from '@/lib/ai/client';
import { SYSTEM_PROMPT, DISCLAIMER } from '@/lib/ai/prompts';
import { AI_TOOLS, executeFunction } from '@/lib/ai/functions';
import type OpenAI from 'openai';

type ChatMessage = OpenAI.Chat.Completions.ChatMessage;

const MAX_FUNCTION_ROUNDS = 5;

export async function POST(request: Request) {
  try {
    const supabase = createServerSupabaseClient();
    const { data: { user } } = await supabase.auth.getUser();

    if (!user) {
      return NextResponse.json({ error: 'Authentication required.' }, { status: 401 });
    }

    await requireMFA(supabase);

    const rateCheck = checkRateLimit(RATE_LIMITS.AI_CHAT, user.id);
    if (!rateCheck.allowed) {
      return NextResponse.json({ error: 'Too many requests.' }, { status: 429 });
    }

    const body = await request.json();
    const { message, conversationId } = body as {
      message?: string;
      conversationId?: string;
    };

    if (!message || typeof message !== 'string' || message.trim().length === 0) {
      return NextResponse.json({ error: 'Message is required.' }, { status: 400 });
    }

    if (message.length > 2000) {
      return NextResponse.json({ error: 'Message too long (max 2000 chars).' }, { status: 400 });
    }

    const ip = getClientIP(request.headers) ?? 'unknown';

    // --- Conversation management ---
    let convId = conversationId;

    if (!convId) {
      // Create a new conversation
      const { data: conv, error: convError } = await supabase
        .from('ai_conversations')
        .insert({
          user_id: user.id,
          title: message.slice(0, 100),
          message_count: 0,
        })
        .select('id')
        .single();

      if (convError || !conv) {
        logger.error('Failed to create conversation', { error_message: convError?.message });
        return NextResponse.json({ error: 'Failed to create conversation.' }, { status: 500 });
      }

      convId = conv.id;

      await writeAuditLog(supabase, {
        userId: user.id,
        action: 'AI_SESSION_STARTED',
        entityId: convId,
        ipAddress: ip,
      });
    }

    // Store user message
    await supabase.from('ai_messages').insert({
      conversation_id: convId,
      role: 'user',
      content: message.trim(),
    });

    // --- Build message history from DB (last 10 messages for context) ---
    const { data: history } = await supabase
      .from('ai_messages')
      .select('role, content')
      .eq('conversation_id', convId)
      .order('created_at', { ascending: true })
      .limit(20);

    const messages: ChatMessage[] = [
      { role: 'system', content: SYSTEM_PROMPT },
      ...((history ?? []).map((m: { role: string; content: string }) => ({
        role: m.role as 'user' | 'assistant',
        content: m.content,
      }))),
    ];

    // --- OpenAI call with function-calling loop ---
    const openai = getOpenAIClient();
    const functionCallsLog: string[] = [];
    let assistantContent = '';
    let rounds = 0;

    while (rounds < MAX_FUNCTION_ROUNDS) {
      rounds++;

      const completion = await openai.chat.completions.create({
        model: AI_MODEL,
        max_tokens: AI_MAX_TOKENS,
        messages,
        tools: AI_TOOLS,
        tool_choice: rounds === 1 ? 'auto' : 'auto',
      });

      const choice = completion.choices[0];

      if (!choice) {
        assistantContent = 'I was unable to generate a response. Please try again.';
        break;
      }

      // If the model wants to call functions
      if (choice.finish_reason === 'tool_calls' && choice.message.tool_calls) {
        // Add the assistant message with tool calls to context
        messages.push(choice.message);

        // Execute each function call
        for (const toolCall of choice.message.tool_calls) {
          const fnName = toolCall.function.name;
          const fnArgs = JSON.parse(toolCall.function.arguments || '{}');

          functionCallsLog.push(fnName);

          // Audit log function name only (not data)
          await writeAuditLog(supabase, {
            userId: user.id,
            action: 'AI_FUNCTION_CALLED',
            entityId: convId,
            ipAddress: ip,
            details: { function_name: fnName },
          });

          const result = await executeFunction(fnName, fnArgs, supabase, user.id);

          // Add function result to messages
          messages.push({
            role: 'tool',
            tool_call_id: toolCall.id,
            content: result,
          });
        }

        continue; // Loop back for the model to process the function results
      }

      // Model returned a final text response
      assistantContent = choice.message.content ?? '';
      break;
    }

    // --- Ensure disclaimer is present ---
    if (!assistantContent.includes(DISCLAIMER)) {
      assistantContent += `\n\n*${DISCLAIMER}*`;
    }

    // --- Store assistant response as summary (not raw financial payloads) ---
    await supabase.from('ai_messages').insert({
      conversation_id: convId,
      role: 'assistant',
      content: assistantContent,
      function_calls: functionCallsLog.length > 0
        ? functionCallsLog.map((fn) => ({ name: fn }))
        : null,
    });

    // Update conversation metadata
    await supabase
      .from('ai_conversations')
      .update({
        message_count: (history?.length ?? 0) + 2, // +user +assistant
        last_message_at: new Date().toISOString(),
        summary: generateConversationSummary(message, assistantContent),
      })
      .eq('id', convId);

    return NextResponse.json({
      conversationId: convId,
      message: assistantContent,
      functionsCalled: functionCallsLog,
    });
  } catch (error) {
    logger.error('AI chat error', { error_message: String(error) });
    const clientError = toClientError(error);
    return NextResponse.json({ error: clientError.error }, { status: clientError.status });
  }
}

/**
 * Generate a brief summary of the exchange for conversation storage.
 * Stores the gist, not raw financial data.
 */
function generateConversationSummary(userMessage: string, assistantResponse: string): string {
  const userSnippet = userMessage.slice(0, 80);
  // Extract first sentence of assistant response (before any data)
  const firstSentence = assistantResponse
    .split(/[.!?\n]/)[0]
    ?.trim()
    .slice(0, 120);
  return `Q: ${userSnippet}${userMessage.length > 80 ? '...' : ''} | A: ${firstSentence ?? 'Response provided'}`;
}
