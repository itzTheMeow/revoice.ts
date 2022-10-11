export type VortexPacketType =
  | "InitializeTransports"
  | "Authenticate"
  | "ConnectTransport"
  | "StartProduce"
  | "StopProduce"
  | "UserJoined"
  | "RoomInfo"
  | "UserLeft";

export enum RevoiceState {
  OFFLINE, // not joined anywhere
  IDLE, // joined, but not playing
  BUFFERING, // joined, buffering data
  PLAYING, // joined and playing
  PAUSED, // joined and paused
  JOINING, // join process active
  UNKNOWN, // online but a Media instance is used to play audio
}
