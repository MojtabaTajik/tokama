export const send = () => fetch("https://example.com");
export const socket = () => new WebSocket("wss://example.com");
export const events = () => new EventSource("https://example.com");
