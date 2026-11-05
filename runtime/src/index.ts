// @browser-vm/runtime: the Runtime API, and the types every layer shares.
//
// Surfaces import only types from here, plus the protocol from
// "@browser-vm/runtime/rpc", so the emulator never lands in their bundles.
// Whoever hosts the runtime (host/runtime-frame, surfaces/mcp) imports Runtime.
export { Runtime } from "./runtime.ts";
export type { BootOptions, BootResult, PlaygroundInfo, TerminalInfo } from "./runtime.ts";
export type { VmState } from "./vm.ts";
export type { DirEntry, FileKind, FsChange, FsErrorCode, SearchScope, TextMatch, TextQuery, VmStat } from "./vmfs.ts";
export type { Gate, GateHooks, GateNotice, SecretPlaceholder } from "./gate.ts";
export type { FetchLike, GuestError, GuestRequestInit } from "./net.ts";
export type { AgentReply, AgentRequest, ExecResult } from "./agent-client.ts";
