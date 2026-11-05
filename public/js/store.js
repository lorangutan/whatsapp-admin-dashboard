// Shared app state and lead actions used by several views.
import { api, toast, copy, phoneOf } from './lib.js';
import { t } from './i18n.js';

export const store = {
  shop: null,
  /** { username, role, shopName } of the logged-in account. */
  session: null,
  channels: [],
  quickReplies: [],
  /** Notifies views that a chat changed locally (optimistic) or on the server. */
  events: new EventTarget(),
};

export const stages = () => store.shop?.pipelineStages ?? [];
export const stageById = (id) => stages().find((s) => s.id === id);
export const stageName = (id) => (id === 'none' ? t('Bukan lead') : t(stageById(id)?.name ?? ''));
export const stageClass = (id) => {
  const o = stageById(id)?.outcome;
  return o === 'won' ? 'won' : o === 'lost' ? 'lost' : 'stage';
};

export async function loadBase() {
  const [shop, channels, quickReplies] = await Promise.all([
    api('/api/shop'),
    api('/api/channels'),
    api('/api/quick-replies'),
  ]);
  Object.assign(store, { shop, channels, quickReplies });
}

export async function refreshChannels() {
  store.channels = await api('/api/channels');
  store.events.dispatchEvent(new Event('channels'));
}

export function emitChat(chat) {
  store.events.dispatchEvent(new CustomEvent('chat', { detail: chat }));
}

/**
 * Optimistic lead update: callers have already changed their UI; this saves in the background
 * and rolls back through `revert` if the server refuses.
 */
export async function patchLead(chat, patch, revert) {
  const before = Object.fromEntries(Object.keys(patch).map((k) => [k, chat[k]]));
  Object.assign(chat, patch);
  emitChat(chat);
  try {
    const saved = await api(`/api/chats/${chat.id}`, { method: 'PATCH', body: patch });
    Object.assign(chat, saved);
    emitChat(chat);
  } catch (err) {
    Object.assign(chat, before);
    emitChat(chat);
    revert?.();
    toast(t('Gagal menyimpan: {e}', { e: err.message }), { error: true });
  }
}

export function moveStage(chat, stage) {
  const prev = chat.stage;
  if (prev === stage) return;
  patchLead(chat, { stage });
  toast(`${chat.contactName ?? phoneOf(chat.remoteJid)} → ${stageName(stage) || t('tanpa tahap')}`, {
    action: t('Urungkan'),
    onAction: () => patchLead(chat, { stage: prev }),
  });
}

export function tomorrowAt(hour = 9) {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  d.setHours(hour, 0, 0, 0);
  return d;
}

export async function addFollowup(chat, dueAt, note = '') {
  try {
    await api(`/api/chats/${chat.id}/followups`, { method: 'POST', body: { dueAt: dueAt.toISOString(), note } });
    if (!chat.nextFollowupAt || new Date(chat.nextFollowupAt) > dueAt) chat.nextFollowupAt = dueAt.toISOString();
    emitChat(chat);
    toast(t('Follow-up dijadwalkan'));
  } catch (err) {
    toast(err.message, { error: true });
  }
}

/** Optimistic "tuntas" toggle; marking offers Undo. A new customer message reopens it server-side. */
export async function setResolved(chat, resolved) {
  const before = { resolved: chat.resolved, resolvedAt: chat.resolvedAt };
  Object.assign(chat, { resolved, resolvedAt: resolved ? new Date().toISOString() : null });
  emitChat(chat);
  try {
    Object.assign(chat, await api(`/api/chats/${chat.id}/resolve`, { method: resolved ? 'POST' : 'DELETE' }));
    emitChat(chat);
    if (resolved) toast(t('Ditandai tuntas'), { action: t('Urungkan'), onAction: () => setResolved(chat, false) });
  } catch (err) {
    Object.assign(chat, before);
    emitChat(chat);
    toast(err.message, { error: true });
  }
}

export async function markRead(chat) {
  if (!chat.unread) return;
  chat.unread = 0;
  emitChat(chat);
  api(`/api/chats/${chat.id}/read`, { method: 'POST' }).catch(() => {});
}

/** Context-menu items shared by chat rows, pipeline cards and the conversation header. */
export function leadMenu(chat, { onOpen } = {}) {
  return [
    ...(onOpen ? [{ label: t('Buka chat'), icon: 'chat', onClick: onOpen }, 'sep'] : []),
    { section: t('Pindahkan ke tahap') },
    ...stages().map((s) => ({
      label: t(s.name),
      icon: s.outcome === 'won' ? 'money' : s.outcome === 'lost' ? 'ban' : 'arrow',
      current: chat.stage === s.id,
      onClick: () => moveStage(chat, s.id),
    })),
    'sep',
    chat.resolved
      ? { label: t('Buka lagi'), icon: 'refresh', onClick: () => setResolved(chat, false) }
      : { label: t('Tandai tuntas'), icon: 'checkCircle', onClick: () => setResolved(chat, true) },
    { label: t('Follow-up besok 09.00'), icon: 'clock', onClick: () => addFollowup(chat, tomorrowAt()) },
    ...(chat.unread ? [{ label: t('Tandai sudah dibaca'), icon: 'eye', onClick: () => markRead(chat) }] : []),
    { label: t('Salin nomor'), icon: 'copy', onClick: () => copy(phoneOf(chat.remoteJid)) },
    chat.stage === 'none'
      ? { label: t('Jadikan lead'), icon: 'plus', onClick: () => moveStage(chat, stages()[0]?.id ?? 'new') }
      : { label: t('Bukan lead'), icon: 'ban', danger: true, onClick: () => moveStage(chat, 'none') },
  ];
}
