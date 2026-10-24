/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** API origin when it is on another host; unset = same origin. */
  readonly VITE_API_BASE_URL?: string;
}
