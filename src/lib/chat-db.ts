import { supabase } from "@/integrations/supabase/client";
import type { UIMessage } from "ai";

export type Conversation = {
  id: string;
  title: string;
  model: string;
  pinned: boolean;
  updated_at: string;
  created_at: string;
};

export async function listConversations(): Promise<Conversation[]> {
  const { data, error } = await supabase
    .from("conversations")
    .select("id,title,model,pinned,updated_at,created_at")
    .order("pinned", { ascending: false })
    .order("updated_at", { ascending: false });
  if (error) throw error;
  return (data as Conversation[]) ?? [];
}

export async function createConversation(title = "New chat"): Promise<Conversation> {
  const { data: u } = await supabase.auth.getUser();
  if (!u.user) throw new Error("Not authenticated");
  const { data, error } = await supabase
    .from("conversations")
    .insert({ title, user_id: u.user.id })
    .select("id,title,model,pinned,updated_at,created_at")
    .single();
  if (error) throw error;
  return data as Conversation;
}

export async function updateConversation(id: string, patch: Partial<Conversation>) {
  const { error } = await supabase.from("conversations").update(patch).eq("id", id);
  if (error) throw error;
}

export async function deleteConversation(id: string) {
  const { error } = await supabase.from("conversations").delete().eq("id", id);
  if (error) throw error;
}

export async function loadMessages(conversationId: string): Promise<UIMessage[]> {
  const { data, error } = await supabase
    .from("messages")
    .select("id,role,parts,created_at")
    .eq("conversation_id", conversationId)
    .order("created_at", { ascending: true });
  if (error) throw error;
  return ((data as { id: string; role: string; parts: unknown }[]) ?? []).map((m) => ({
    id: m.id,
    role: m.role as UIMessage["role"],
    parts: (m.parts as UIMessage["parts"]) ?? [],
  }));
}
