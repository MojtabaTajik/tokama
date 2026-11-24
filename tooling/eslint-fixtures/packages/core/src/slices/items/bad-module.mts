import { connect } from "node:net";

export const open = () => connect(80);
