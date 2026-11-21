/**
 * Shared vocabulary.
 *
 * These names mirror the server's `MessageStatus` exactly (see
 * backend/src/domain/message.ts). They are duplicated rather than shared because
 * the two codebases ship separately - a phone in a drawer runs last month's APK
 * against this month's server - so pretending they are one type would hide the
 * version skew rather than remove it.
 *
 * QUEUED and CANCELLED are absent on purpose: the phone never sees either. A
 * message only reaches this device once it has already been dispatched, and by
 * then it is SENDING.
 */
export type MessageStatus = 'SENDING' | 'SENT' | 'DELIVERED' | 'FAILED';
