// allowed: kernel/egress may use the network.
import { request } from "node:https";

export const send = (url: string) => fetch(url);
export const raw = request;
