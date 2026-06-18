import ReactDOM from "react-dom/client";
import App from "./App";
import "./index.css";
// LiveKit's prebuilt component styles (video tiles, control bar, etc.).
import "@livekit/components-styles";

// NOTE: intentionally NOT wrapped in <React.StrictMode>. Strict mode double-invokes
// effects in dev, which makes a live WebSocket + LiveKit room connect/disconnect
// twice and is confusing while learning. Re-enable it if you want the extra checks.
ReactDOM.createRoot(document.getElementById("root")!).render(<App />);
