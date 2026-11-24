// kernel/process may spawn processes, but network calls belong to kernel/egress.
export const send = () => fetch("https://example.com");
