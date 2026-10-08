export interface TgMessage {
  message_id: number;
  text?: string;
  chat: { id: number };
  from?: { username?: string };
}

export interface TgUpdate {
  update_id: number;
  message?: TgMessage;
}

export interface Telegram {
  getMe(): Promise<{ username: string }>;
  sendMessage(chatId: number, text: string): Promise<void>;
  getUpdates(offset: number, timeoutSec: number): Promise<TgUpdate[]>;
}

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export function createTelegram(token: string, fetchFn: FetchLike = fetch): Telegram {
  const call = async <T>(method: string, payload: Record<string, unknown>): Promise<T> => {
    const res = await fetchFn(`https://api.telegram.org/bot${token}/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const body = (await res.json()) as { ok: boolean; result?: T; description?: string };
    if (!res.ok || !body.ok) {
      throw new Error(`telegram ${method}: ${body.description ?? `http ${res.status}`}`);
    }
    return body.result as T;
  };

  return {
    getMe: () => call<{ username: string }>('getMe', {}),
    sendMessage: async (chatId, text) => {
      await call('sendMessage', { chat_id: chatId, text: text.slice(0, 4096) });
    },
    getUpdates: (offset, timeoutSec) =>
      call<TgUpdate[]>('getUpdates', {
        offset,
        timeout: timeoutSec,
        allowed_updates: ['message'],
      }),
  };
}
