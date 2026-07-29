import { createFileRoute, Outlet, redirect, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { Menu } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { AuthProvider, useAuth } from "@/lib/auth-context";
import { Sidebar, useActiveConversationId } from "@/components/chat/Sidebar";
import { listConversations, type Conversation } from "@/lib/chat-db";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent } from "@/components/ui/sheet";
import logo from "@/assets/logo.png";

export const Route = createFileRoute("/_authenticated")({
  ssr: false,
  beforeLoad: async () => {
    const { data } = await supabase.auth.getSession();
    if (!data.session) {
      throw redirect({ to: "/auth" });
    }
  },
  component: () => (
    <AuthProvider>
      <AuthedShell />
    </AuthProvider>
  ),
});

function AuthedShell() {
  const { loading, user } = useAuth();
  const navigate = useNavigate();
  const activeId = useActiveConversationId();
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [mobileOpen, setMobileOpen] = useState(false);

  const refetch = () => {
    listConversations().then(setConversations).catch(() => {});
  };

  useEffect(() => {
    if (!user) return;
    refetch();
    const onChange = () => refetch();
    window.addEventListener("conversations:changed", onChange);
    return () => window.removeEventListener("conversations:changed", onChange);
  }, [user]);

  useEffect(() => {
    if (!loading && !user) navigate({ to: "/auth" });
  }, [loading, user, navigate]);

  if (loading) {
    return <div className="flex h-screen items-center justify-center text-sm text-muted-foreground">Loading…</div>;
  }

  return (
    <div className="aurora-bg flex h-screen w-full bg-background text-foreground">
      <div className="aurora-blobs" aria-hidden="true" />
      <div className="hidden md:block relative z-10">
        <Sidebar conversations={conversations} refetch={refetch} activeId={activeId} />
      </div>
      <Sheet open={mobileOpen} onOpenChange={setMobileOpen}>
        <SheetContent side="left" className="p-0 w-72 border-r border-border/40">
          <Sidebar
            conversations={conversations}
            refetch={refetch}
            activeId={activeId}
            onClose={() => setMobileOpen(false)}
          />
        </SheetContent>
      </Sheet>
      <main className="flex-1 flex flex-col min-w-0 relative z-10">
        <div className="md:hidden flex items-center justify-between border-b border-border/50 glass-panel px-2 py-2">
          <Button variant="ghost" size="icon" onClick={() => setMobileOpen(true)} aria-label="Menu">
            <Menu className="h-5 w-5" />
          </Button>
          <div className="flex items-center gap-1.5">
            <img src={logo} alt="JABBI AI" width={22} height={22} className="h-5 w-5" />
            <span className="text-sm font-semibold text-brand-gradient">JABBI AI</span>
          </div>
          <div className="w-9" />
        </div>
        <div className="flex-1 min-h-0">
          <Outlet />
        </div>
      </main>
    </div>
  );
}
