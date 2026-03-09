'use client';

import { useState, useRef, useEffect, useCallback } from 'react';
import { Send, Bot, User, Loader2, AlertCircle, RotateCcw } from 'lucide-react';

interface Message {
  role: 'user' | 'assistant';
  content: string;
  functionsCalled?: string[];
}

export default function AICoachPage() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [conversationId, setConversationId] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Auto-scroll to bottom on new messages
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages, loading]);

  // Focus input on mount
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const handleSend = useCallback(async (e: React.FormEvent) => {
    e.preventDefault();
    const text = input.trim();
    if (!text || loading) return;

    setInput('');
    setError(null);
    setMessages((prev) => [...prev, { role: 'user', content: text }]);
    setLoading(true);

    try {
      const res = await fetch('/api/ai/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: text,
          conversationId,
        }),
      });

      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error ?? `Request failed (${res.status})`);
      }

      const data = await res.json();

      if (data.conversationId && !conversationId) {
        setConversationId(data.conversationId);
      }

      setMessages((prev) => [
        ...prev,
        {
          role: 'assistant',
          content: data.message,
          functionsCalled: data.functionsCalled,
        },
      ]);
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : 'Something went wrong';
      setError(errorMessage);
      setMessages((prev) => [
        ...prev,
        {
          role: 'assistant',
          content: 'I encountered an error processing your request. Please try again.',
        },
      ]);
    } finally {
      setLoading(false);
      inputRef.current?.focus();
    }
  }, [input, loading, conversationId]);

  function handleNewChat() {
    setMessages([]);
    setConversationId(null);
    setError(null);
    inputRef.current?.focus();
  }

  return (
    <div className="flex h-[calc(100vh-8rem)] flex-col">
      {/* Header */}
      <div className="mb-4 flex items-start justify-between">
        <div>
          <div className="flex items-center gap-2">
            <Bot className="h-5 w-5 text-blue-600" />
            <h2 className="text-xl font-semibold text-gray-900">Budget Coach</h2>
          </div>
          <p className="mt-0.5 text-sm text-gray-500">
            Educational financial analysis based on your data. Not financial advice.
          </p>
        </div>
        {messages.length > 0 && (
          <button
            onClick={handleNewChat}
            className="flex items-center gap-1.5 rounded-md border border-gray-200 px-3 py-1.5 text-xs text-gray-600 hover:bg-gray-50"
          >
            <RotateCcw className="h-3 w-3" />
            New Chat
          </button>
        )}
      </div>

      {/* Messages */}
      <div
        ref={scrollRef}
        className="flex-1 space-y-4 overflow-y-auto rounded-lg border bg-white p-4"
      >
        {messages.length === 0 && (
          <EmptyState />
        )}
        {messages.map((msg, i) => (
          <ChatBubble key={i} message={msg} />
        ))}
        {loading && (
          <div className="flex items-start gap-3">
            <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-blue-100">
              <Bot className="h-4 w-4 text-blue-600" />
            </div>
            <div className="rounded-lg bg-gray-50 px-4 py-3">
              <div className="flex items-center gap-2 text-sm text-gray-400">
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                Analyzing your finances...
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Error banner */}
      {error && (
        <div className="mt-2 flex items-center gap-2 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
          <AlertCircle className="h-3.5 w-3.5 shrink-0" />
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
          placeholder="Ask about your spending, budget, investments..."
          maxLength={2000}
          className="flex-1 rounded-md border border-gray-300 px-3 py-2.5 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
          disabled={loading}
        />
        <button
          type="submit"
          disabled={loading || !input.trim()}
          className="flex items-center gap-1.5 rounded-md bg-blue-600 px-4 py-2.5 text-sm font-medium text-white hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-50"
        >
          <Send className="h-4 w-4" />
          Send
        </button>
      </form>

      <p className="mt-2 text-center text-[11px] text-gray-400">
        This is educational context, not financial advice. Consult a qualified advisor for personalized recommendations.
      </p>
    </div>
  );
}

function EmptyState() {
  const suggestions = [
    'How is my spending this month?',
    'Explain my portfolio allocation',
    'What are my recurring expenses?',
    'Am I on track with my budget?',
  ];

  return (
    <div className="flex h-full flex-col items-center justify-center py-8">
      <Bot className="h-12 w-12 text-gray-200" />
      <p className="mt-3 text-lg font-medium text-gray-400">Start a conversation</p>
      <p className="mt-1 text-sm text-gray-300">
        Your Budget Coach analyzes your real financial data to help you learn.
      </p>
      <div className="mt-4 flex flex-wrap justify-center gap-2">
        {suggestions.map((s) => (
          <span
            key={s}
            className="cursor-default rounded-full border border-gray-200 px-3 py-1 text-xs text-gray-400"
          >
            &quot;{s}&quot;
          </span>
        ))}
      </div>
    </div>
  );
}

function ChatBubble({ message }: { message: Message }) {
  const isUser = message.role === 'user';

  return (
    <div className={`flex items-start gap-3 ${isUser ? 'flex-row-reverse' : ''}`}>
      <div
        className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-full ${
          isUser ? 'bg-blue-600' : 'bg-blue-100'
        }`}
      >
        {isUser ? (
          <User className="h-4 w-4 text-white" />
        ) : (
          <Bot className="h-4 w-4 text-blue-600" />
        )}
      </div>
      <div
        className={`max-w-[80%] rounded-lg px-4 py-3 text-sm ${
          isUser ? 'bg-blue-600 text-white' : 'bg-gray-50 text-gray-900'
        }`}
      >
        {isUser ? (
          <p className="whitespace-pre-wrap">{message.content}</p>
        ) : (
          <div className="space-y-1.5">
            <FormattedContent content={message.content} />
          </div>
        )}
        {message.functionsCalled && message.functionsCalled.length > 0 && (
          <div className="mt-2 flex flex-wrap gap-1 border-t border-gray-200 pt-2">
            {message.functionsCalled.map((fn, i) => (
              <span key={i} className="rounded bg-gray-200 px-1.5 py-0.5 text-[10px] text-gray-500">
                {fn.replace('get_', '').replace(/_/g, ' ')}
              </span>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * Simple markdown-like formatter for assistant responses.
 * Handles bold, italic, bullet points, and line breaks.
 */
function FormattedContent({ content }: { content: string }) {
  const lines = content.split('\n');

  return (
    <>
      {lines.map((line, i) => {
        if (line.trim() === '') return <br key={i} />;

        // Bullet points
        if (line.trim().startsWith('- ') || line.trim().startsWith('* ')) {
          return (
            <div key={i} className="flex gap-1.5 pl-1">
              <span className="text-gray-400 select-none">&#8226;</span>
              <span><InlineFormat text={line.trim().slice(2)} /></span>
            </div>
          );
        }

        // Headers
        if (line.trim().startsWith('### ')) {
          return <p key={i} className="font-semibold mt-2"><InlineFormat text={line.trim().slice(4)} /></p>;
        }
        if (line.trim().startsWith('## ')) {
          return <p key={i} className="font-semibold mt-2"><InlineFormat text={line.trim().slice(3)} /></p>;
        }

        return <p key={i}><InlineFormat text={line} /></p>;
      })}
    </>
  );
}

function InlineFormat({ text }: { text: string }) {
  // Handle **bold** and *italic*
  const parts = text.split(/(\*\*[^*]+\*\*|\*[^*]+\*)/g);

  return (
    <>
      {parts.map((part, i) => {
        if (part.startsWith('**') && part.endsWith('**')) {
          return <strong key={i}>{part.slice(2, -2)}</strong>;
        }
        if (part.startsWith('*') && part.endsWith('*')) {
          return <em key={i}>{part.slice(1, -1)}</em>;
        }
        return <span key={i}>{part}</span>;
      })}
    </>
  );
}
