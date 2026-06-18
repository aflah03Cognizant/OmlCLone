// web/src/components/QueueScreen.tsx — shown while waiting for a match.
export default function QueueScreen({
  handle,
  onCancel,
}: {
  handle: string;
  onCancel: () => void;
}) {
  return (
    <div className="min-h-full flex items-center justify-center bg-gray-950 text-gray-100 p-4">
      <div className="text-center space-y-5">
        <div className="mx-auto h-10 w-10 rounded-full border-2 border-gray-700 border-t-indigo-500 animate-spin" />
        <div>
          <div className="text-lg font-medium">Looking for someone to chat with…</div>
          <div className="text-sm text-gray-400 mt-1">You're in the queue as {handle}</div>
        </div>
        <button
          onClick={onCancel}
          className="rounded-lg border border-gray-700 hover:bg-gray-800 px-4 py-2 text-sm"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}
