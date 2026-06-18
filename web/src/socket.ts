// web/src/socket.ts — one shared Socket.IO connection for the whole app.
import { io, type Socket } from "socket.io-client";

const BACKEND = import.meta.env.VITE_BACKEND_URL ?? "http://localhost:3000";

// Server -> client events we listen for.
export interface MatchPayload {
  roomName: string;
  token: string;
  peer: string;
}

export const socket: Socket = io(BACKEND, { autoConnect: true });
