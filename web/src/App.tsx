// web/src/App.tsx
//
// Tiny state machine that drives the whole user flow:
//   start  -> enter handle + accept recording notice
//   queue  -> waiting for the matchmaker to pair you
//   call   -> in a LiveKit room with your peer; "Next" requeues
//
// All realtime coordination is over the shared Socket.IO connection.
import { useEffect, useRef, useState } from "react";
import { socket, type MatchPayload } from "./socket";
import StartScreen from "./components/StartScreen";
import QueueScreen from "./components/QueueScreen";
import CallScreen from "./components/CallScreen";

type User = { id: string; handle: string };
type Phase = "start" | "queue" | "call";

export default function App() {
  const [user, setUser] = useState<User | null>(null);
  const [phase, setPhase] = useState<Phase>("start");
  const [match, setMatch] = useState<MatchPayload | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  // Guard so we requeue exactly once per room (both the "Next" button and the
  // LiveKit onDisconnected callback can fire for the same room).
  const requeuedFor = useRef<string | null>(null);

  useEffect(() => {
    const onMatched = (m: MatchPayload) => {
      setMatch(m);
      setPhase("call");
    };
    const onQueued = () => setPhase("queue");
    const onNeedsConsent = () => {
      setNotice("Please accept the recording notice before joining.");
      setPhase("start");
    };

    socket.on("matched", onMatched);
    socket.on("queued", onQueued);
    socket.on("needs_consent", onNeedsConsent);
    return () => {
      socket.off("matched", onMatched);
      socket.off("queued", onQueued);
      socket.off("needs_consent", onNeedsConsent);
    };
  }, []);

  function enterQueue(u: User) {
    setUser(u);
    setNotice(null);
    setPhase("queue");
    socket.emit("join_queue", { userId: u.id, handle: u.handle });
  }

  // Go back to the queue, optionally after a specific room ended.
  function requeue(room: string | null) {
    if (room && requeuedFor.current === room) return; // already handled this room
    if (room) requeuedFor.current = room;
    setMatch(null);
    if (user) {
      setPhase("queue");
      socket.emit("join_queue", { userId: user.id, handle: user.handle });
    } else {
      setPhase("start");
    }
  }

  function next() {
    const room = match?.roomName ?? null;
    if (room) socket.emit("leave", { roomName: room }); // tell server to end the room
    requeue(room);
  }

  function cancelQueue() {
    socket.emit("leave_queue");
    setPhase("start");
  }

  if (phase === "call" && match) {
    return (
      <CallScreen
        match={match}
        onNext={next}
        onDisconnected={() => requeue(match.roomName)}
      />
    );
  }
  if (phase === "queue") {
    return <QueueScreen handle={user?.handle ?? ""} onCancel={cancelQueue} />;
  }
  return <StartScreen onReady={enterQueue} notice={notice} />;
}
