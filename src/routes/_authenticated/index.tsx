import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { Sparkles, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { createConversation } from "@/lib/chat-db";

export const Route = createFileRoute("/_authenticated/")({
  component: Home,
});

function Home() {
  const navigate = useNavigate();
  const [busy, setBusy] = useState(false);

  const startChat = async () => {
    setBusy(true);
    try {
      const c = await createConversation();
      navigate({ to: "/c/$conversationId", params: { conversationId: c.id } });
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    // optionally auto-start; keep landing for clarity
  }, []);

  return (
    <div className="flex h-full flex-col items-center justify-center text-center px-6 gap-4">
      <div className="h-14 w-14 rounded-2xl bg-primary/10 text-primary flex items-center justify-center">
        <Sparkles className="h-7 w-7" />
      </div>
      <h1 className="text-3xl font-semibold tracking-tight">Welcome back</h1>
      <p className="text-sm text-muted-foreground max-w-md">
        Start a new conversation or pick one from the sidebar.
      </p>
      <Button onClick={startChat} disabled={busy} className="gap-2 mt-2">
        <Plus className="h-4 w-4" /> New chat
      </Button>
    </div>
  );
}
