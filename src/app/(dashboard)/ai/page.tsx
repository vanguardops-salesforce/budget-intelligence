export const dynamic = "force-dynamic";

'use client';

import { useState, useRef, useEffect, useCallback } from 'react';
import { GraduationCap, Send, Trash2 } from 'lucide-react';

interface Message {
  role: 'user' | 'assistant';
  content: string;
}

const DISCLAIMER_TEXT =
  'This is educational context, not financial advice. Consult a qualified advisor for personalized recommendations.';

const EXAMPLE_PROMPTS = [
  'How is my spending this month?',
  'Am I on track with my budget?',
  'Explain my portfolio allocation',
  'What does my cash flow forecast look like?',
];

export default function AICoachPage() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const scrollToBottom = useCallback(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, []);

  useEffect(() => {
    scrollToBottom();
  }, [messages, scrollToBottom]);

  function handleNewChat() {
    setMessages([]);
    setConversationId(null);
    setError(null);
    inputRef.current?.focus();
  }

  async function handleSend(e: React.FormEvent) {
    e.preventDefault();
    if (!input.trim() || loading) return;

    const userMessage = input.trim();
    setInput('');
    setError(null);
    setMessages((prev) => [...prev, { role: 'user', content: userMessage }]);
    setLoading(true);

    try {
      const res = await fetch('/api/ai/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: userMessage,
          conversation_id: conversationId ?? undefined,
        }),
      });

      if (res.status === 429) {
        setError('Rate limit reached. Please wait a moment before sending another message.');
        setLoading(false);
        return;
      }

      if (!res.ok) {
        const data = await res.json().catch(() => ({ error: 'Something went wrong.' }));
        throw new Error(data.error || 'Something went wrong.');
      }

      const data = await res.json();

      if (data.conversation_id) {
        setConversationId(data.conversation_id);
      }

      setMessages((prev) => [
        ...prev,
        { role: 'assistant', content: data.message },
      ]);
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : 'Something went wrong.';
      setError(errorMessage);
      setMessages((prev) => [
        ...prev,
        { role: 'assistant', content: `I encountered an error. Please try again.\n\n*${DISCLAIMER_TEXT}*` },
      ]);
    } finally {
      setLoading(false);
    }
  }

  function handleExampleClick(prompt: string) {
    setInput(prompt);
    inputRef.current?.focus();
  }

  return (
    <div className="flex h-[calc(100vh-8rem)] flex-col">
      {/* Header */}
      <div className="mb-4 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-blue-100">
            <GraduationCap className="h-5 w-5 text-blue-600" />
          </div>
          <div>
            <h2 className="text-xl font-semibold text-gray-900">Budget Coach</h2>
            <p className="text-sm text-gray-500">
              Educational financial analysis — not advice
            </p>
          </div>
        </div>
        {messages.length > 0 && (
          <button
            onClick={handleNewChat}
            className="flex items-center gap-1.5 rounded-md border border-gray-300 px-3 py-1.5 text-sm text-gray-600 hover:bg-gray-50"
          >
            <Trash2 className="h-3.5 w-3.5" />
            New Chat
          </button>
        )}
      </div>

      {/* Chat messages */}
      <div className="flex-1 space-y-4 overflow-y-auto rounded-lg border bg-white p-4">
        {messages.length === 0 && (
          <div className="flex h-full flex-col items-center justify-center gap-6">
            <div className="text-center">
              <div className="mx-auto mb-3 flex h-14 w-14 items-center justify-center rounded-full bg-blue-50">
                <GraduationCap className="h-7 w-7 text-blue-500" />
              </div>
              <p className="text-lg font-medium text-gray-500">Budget Coach</p>
              <p className="mt-1 max-w-md text-sm text-gray-400">
                Ask about your spending, budget, cash flow, or investments. I&apos;ll analyze your
                actual data and help you understand patterns.
              </p>
            </div>
            <div className="flex flex-wrap justify-center gap-2">
              {EXAMPLE_PROMPTS.map((prompt) => (
                <button
                  key={prompt}
                  onClick={() => handleExampleClick(prompt)}
                  className="rounded-full border border-gray-200 px-3 py-1.5 text-xs text-gray-600 transition-colors hover:border-blue-300 hover:bg-blue-50 hover:text-blue-700"
                >
                  {prompt}
                </button>
              ))}
            </div>
          </div>
        )}

        {messages.map((msg, i) => (
          <div
            key={i}
            className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}
          >
            <div
              className={`max-w-[80%] rounded-lg px-4 py-3 text-sm ${
                msg.role === 'user'
                  ? 'bg-blue-600 text-white'
                  : 'bg-gray-50 text-gray-900 ring-1 ring-gray-200'
              }`}
            >
              {msg.role === 'assistant' && (
                <div className="mb-1 flex items-center gap-1.5 text-xs font-medium text-blue-600">
                  <GraduationCap className="h-3 w-3" />
                  Coach
                </div>
              )}
              <div className="whitespace-pre-wrap">{msg.content}</div>
            </div>
          </div>
        ))}

        {loading && (
          <div className="flex justify-start">
            <div className="rounded-lg bg-gray-50 px-4 py-3 text-sm ring-1 ring-gray-200">
              <div className="mb-1 flex items-center gap-1.5 text-xs font-medium text-blue-600">
                <GraduationCap className="h-3 w-3" />
                Coach
              </div>
              <div className="flex items-center gap-1 text-gray-400">
                <span className="animate-pulse">Analyzing your data</span>
                <span className="animate-bounce" style={{ animationDelay: '0ms' }}>.</span>
                <span className="animate-bounce" style={{ animationDelay: '150ms' }}>.</span>
                <span className="animate-bounce" style={{ animationDelay: '300ms' }}>.</span>
              </div>
            </div>
          </div>
        )}

        <div ref={messagesEndRef} />
      </div>

      {/* Error banner */}
      {error && (
        <div className="mt-2 rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">
          {error}
        </div>
      )}

      {/* Input */}
      <form onSubmit={handleSend} className="mt-3 flex gap-2">
        <input
          ref={inputRef}
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Ask about your finances..."
          className="flex-1 rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
          disabled={loading}
          maxLength={2000}
        />
        <button
          type="submit"
          disabled={loading || !input.trim()}
          className="flex items-center gap-1.5 rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-50"
        >
          <Send className="h-3.5 w-3.5" />
          Send
        </button>
      </form>

      <p className="mt-2 text-center text-xs text-gray-400">
        {DISCLAIMER_TEXT}
      </p>
    </div>
  );
}
