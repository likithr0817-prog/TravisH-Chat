import { Link, useNavigate, useRouterState } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import {
  Pin,
  PinOff,
  Plus,
  Search,
  Trash2,
  LogOut,
  MessageSquare,
  Moon,
  Sun,
} from "lucide-react";
import { useAuth } from "@/lib/auth-context";
import {
  type Conversation,
  createConversation,
  deleteConversation,
  listConversations,
  updateConversation,
} from "@/lib/chat-db";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { toast } from "sonner";
import logo from "@/assets/logo.png";

type Props = {
  conversations: Conversation[];
  refetch: () => void;
  activeId?: string;
  onClose?: () => void;
};

function ThemeToggle() {
  const [dark, setDark] = useState(() =>
    typeof document !== "undefined" && document.documentElement.classList.contains("dark"),
  );
  useEffect(() => {
    if (typeof document === "undefined") return;
    const stored = localStorage.getItem("theme");
    const initial = stored ? stored === "dark" : window.matchMedia("(prefers-color-scheme: dark)").matches;
    document.documentElement.classList.toggle("dark", initial);
    setDark(initial);
  }, []);
  return (
    <Button
      variant="ghost"
      size="icon"
      onClick={() => {
        const next = !dark;
        document.documentElement.classList.toggle("dark", next);
        localStorage.setItem("theme", next ? "dark" : "light");
        setDark(next);
      }}
      aria-label="Toggle theme"
    >
      {dark ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
    </Button>
  );
}

export function Sidebar({ conversations, refetch, activeId, onClose }: Props) {
  const { user, signOut } = useAuth();
  const navigate = useNavigate();
  const [query, setQuery] = useState("");

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return conversations;
    return conversations.filter((c) => c.title.toLowerCase().includes(q));
  }, [conversations, query]);

  const handleNew = async () => {
    try {
      const c = await createConversation();
      refetch();
      navigate({ to: "/c/$conversationId", params: { conversationId: c.id } });
      onClose?.();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to create chat");
    }
  };

  const handleDelete = async (id: string) => {
    await deleteConversation(id);
    refetch();
    if (activeId === id) navigate({ to: "/" });
  };

  const togglePin = async (c: Conversation) => {
    await updateConversation(c.id, { pinned: !c.pinned });
    refetch();
  };

  return (
    <aside className="relative flex h-full w-72 flex-col border-r border-border/40 glass-panel text-sidebar-foreground">
      <div className="p-3 space-y-3 border-b border-border/40">
        <div className="flex items-center gap-2.5 px-1 pt-1">
          <div className="relative flex h-8 w-8 items-center justify-center">
            <div className="absolute inset-0 rounded-xl bg-brand-gradient opacity-40 blur-md" aria-hidden="true" />
            <img src={logo} alt="" width={32} height={32} className="relative h-8 w-8 rounded-xl" />
          </div>
          <span className="text-base font-semibold tracking-tight text-brand-shimmer">
            JABBI AI
          </span>
        </div>
        <Button
          onClick={handleNew}
          className="w-full justify-start gap-2 bg-brand-gradient text-white border-0 hover:opacity-95 hover:-translate-y-0.5 shadow-brand transition-all duration-200"
        >
          <Plus className="h-4 w-4" /> New chat
        </Button>
        <div className="relative">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search chats"
            className="pl-8 h-9 bg-background/40 border-border/50 focus-visible:border-primary/40"
          />
        </div>
      </div>

      <ScrollArea className="flex-1">
        <nav className="p-2 space-y-0.5">
          {filtered.length > 0 && (
            <p className="px-2 pt-1 pb-1.5 text-[10px] font-medium uppercase tracking-wider text-muted-foreground/70">
              Recent
            </p>
          )}
          {filtered.length === 0 ? (
            <p className="px-2 py-6 text-center text-xs text-muted-foreground">
              {query ? "No matches" : "No chats yet"}
            </p>
          ) : (
            filtered.map((c) => (
              <div
                key={c.id}
                className={`group relative flex items-center gap-1 rounded-lg px-2 py-1.5 text-sm hover-lift hover:bg-sidebar-accent/60 ${
                  activeId === c.id
                    ? "bg-sidebar-accent/70 shadow-sm ring-1 ring-border/50"
                    : ""
                }`}
              >
                {activeId === c.id && (
                  <span
                    className="absolute left-0 top-1/2 -translate-y-1/2 h-5 w-0.5 rounded-r bg-brand-gradient"
                    aria-hidden="true"
                  />
                )}
                <Link
                  to="/c/$conversationId"
                  params={{ conversationId: c.id }}
                  className="flex flex-1 min-w-0 items-center gap-2"
                  onClick={onClose}
                >
                  <MessageSquare className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                  <span className="truncate">{c.title}</span>
                </Link>
                <div className="hidden gap-0.5 group-hover:flex">
                  <button
                    onClick={() => togglePin(c)}
                    className="p-1 rounded hover:bg-background/60"
                    aria-label="Pin"
                  >
                    {c.pinned ? <PinOff className="h-3 w-3" /> : <Pin className="h-3 w-3" />}
                  </button>
                  <button
                    onClick={() => handleDelete(c.id)}
                    className="p-1 rounded hover:bg-background/60 text-destructive"
                    aria-label="Delete"
                  >
                    <Trash2 className="h-3 w-3" />
                  </button>
                </div>
                {c.pinned && (
                  <Pin className="h-3 w-3 text-muted-foreground group-hover:hidden" />
                )}
              </div>
            ))
          )}
        </nav>
      </ScrollArea>

      <div className="border-t border-border/40 p-3 flex items-center gap-2">
        <div className="flex h-8 w-8 items-center justify-center rounded-full bg-brand-gradient text-white text-xs font-medium shadow-brand">
          {(user?.email ?? "?").slice(0, 1).toUpperCase()}
        </div>
        <div className="flex-1 min-w-0">
          <p className="truncate text-sm font-medium">{user?.email}</p>
        </div>
        <ThemeToggle />
        <Button variant="ghost" size="icon" onClick={() => signOut()} aria-label="Sign out">
          <LogOut className="h-4 w-4" />
        </Button>
      </div>
    </aside>
  );
}

export function useActiveConversationId() {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const match = pathname.match(/^\/c\/([^/]+)/);
  return match?.[1];
}
