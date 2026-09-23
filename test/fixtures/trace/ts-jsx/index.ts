import { msg } from "./mod";
import { el } from "./view.jsx";

export const out = `${msg}:${(el as any).type}`;
