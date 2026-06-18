// web/src/components/CallScreen.tsx
//
// The live call. We use LiveKit's React components to do the heavy lifting:
//   - <LiveKitRoom> connects with our token and publishes camera + mic.
//   - <useTracks>/<GridLayout>/<ParticipantTile> render local + remote camera tiles.
//   - <RoomAudioRenderer> plays the peer's audio.
//   - <ControlBar> gives mic/camera toggles (we hide its leave button — "Next" is ours).
import {
  LiveKitRoom,
  GridLayout,
  ParticipantTile,
  RoomAudioRenderer,
  ControlBar,
  useTracks,
} from "@livekit/components-react";
import { Track } from "livekit-client";
import type { MatchPayload } from "../socket";

const LIVEKIT_URL = import.meta.env.VITE_LIVEKIT_URL ?? "ws://localhost:7880";

// Renders one tile per camera track (local + remote). Must live inside <LiveKitRoom>.
function Stage() {
  const tracks = useTracks([{ source: Track.Source.Camera, withPlaceholder: true }], {
    onlySubscribed: false,
  });
  return (
    <GridLayout tracks={tracks} style={{ height: "100%" }}>
      <ParticipantTile />
    </GridLayout>
  );
}

export default function CallScreen({
  match,
  onNext,
  onDisconnected,
}: {
  match: MatchPayload;
  onNext: () => void;
  onDisconnected: () => void;
}) {
  return (
    <div className="h-full flex flex-col bg-gray-950 text-white" data-lk-theme="default">
      <div className="flex items-center justify-between px-4 py-3 border-b border-gray-800 shrink-0">
        <div>
          <div className="text-xs text-gray-400">In a call with</div>
          <div className="font-semibold">{match.peer}</div>
        </div>
        <div className="flex items-center gap-4">
          <span className="text-xs text-red-400 flex items-center gap-1">
            <span className="h-2 w-2 rounded-full bg-red-500 animate-pulse" /> recording
          </span>
          <button
            onClick={onNext}
            className="rounded-lg bg-indigo-600 hover:bg-indigo-500 px-4 py-2 font-medium"
          >
            Next →
          </button>
        </div>
      </div>

      <div className="flex-1 relative min-h-0">
        <LiveKitRoom
          token={match.token}
          serverUrl={LIVEKIT_URL}
          connect={true}
          video={true}
          audio={true}
          onDisconnected={onDisconnected}
          style={{ height: "100%" }}
        >
          <Stage />
          <RoomAudioRenderer />
          <div className="absolute bottom-0 inset-x-0 flex justify-center">
            <ControlBar
              variation="minimal"
              controls={{ microphone: true, camera: true, screenShare: false, leave: false }}
            />
          </div>
        </LiveKitRoom>
      </div>
    </div>
  );
}
