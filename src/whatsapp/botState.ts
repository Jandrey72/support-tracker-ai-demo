import type { WASocket } from '@whiskeysockets/baileys';

let status: 'connected' | 'disconnected' | 'conflict' = 'disconnected';
let manualStop = false;
let currentSock: WASocket | null = null;

export function setBotStatus(s: typeof status) { status = s; }
export function getBotStatus() { return status; }

export function setManualStop(v: boolean) { manualStop = v; }
export function isManualStop() { return manualStop; }

export function setCurrentSock(sock: WASocket | null) { currentSock = sock; }
export function getCurrentSock() { return currentSock; }
