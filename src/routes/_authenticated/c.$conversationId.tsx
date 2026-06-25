import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import type { UIMessage } from "ai";
import { supabase } from "@/integrations/supabase/client";
import { loadMessages } from "@/lib/chat-db";
import { ChatWindow } from "@/components/chat/ChatWindow";

type ConvMeta = { id: string; title: string; model: string };

export const Route = createFileRoute("/_authenticated/c/$conversationId")({
  component: ChatPage,
});

function ChatPage() {
  const { conversationId } = Route.useParams();
  const [meta, setMeta] = useState<ConvMeta | null>(null);
  const [messages, setMessages] = useState<UIMessage[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    (async () => {
      const { data, error } = await supabase
        .from("conversations")
        .select("id,title,model")
        .eq("id", conversationId)
        .maybeSingle();
      if (cancelled) return;
      if (error || !data) {
        setError("Conversation not found");
        setLoading(false);
        return;
      }
      const msgs = await loadMessages(conversationId);
      if (cancelled) return;
      setMeta(data as ConvMeta);
      setMessages(msgs);
      setLoading(false);
    })().catch((e) => {
      if (!cancelled) {
        setError(e?.message ?? "Failed to load");
        setLoading(false);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [conversationId]);

  if (loading) {
    return <div className="flex h-full items-center justify-center text-sm text-muted-foreground">Loading chat…</div>;
  }
  if (error || !meta) {
    return <div className="flex h-full items-center justify-center text-sm text-muted-foreground">{error}</div>;
  }

  return (
    <ChatWindow
      key={conversationId}
      conversationId={conversationId}
      initialMessages={messages}
      initialModel={meta.model}
      initialTitle={meta.title}
      onTitled={() => {
        // trigger sidebar refresh via custom event
        window.dispatchEvent(new Event("conversations:changed"));
      }}
    />
  );
}

// satisfy TypeScript notFound import if unused
void notFound;
