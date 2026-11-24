import { request } from "node:https";

export const Panel = () => <div>{String(request)}</div>;
