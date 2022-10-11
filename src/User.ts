import EventEmitter from "events";
import * as Revolt from "revolt-api";

export default class User {
  public connected = true; // gets changed from outside
  public connectedTo = null; // same as connected
  public emitter = new EventEmitter();
  public username: string;
  public badges: number;
  public relationship: Revolt.User["relationship"];
  public online: boolean;
  public rawData: Revolt.User;
  public muted = false;

  constructor(public id: string, public api: Revolt.API) {
    this.api.get(`/users/${id}`).then((res: Revolt.User) => {
      this.username = res.username;
      this.badges = res.badges;
      this.relationship = res.relationship;
      this.online = res.online;
      this.rawData = res;
      this.emit("ready");
    });

    return this;
  }
  on(event: string, cb: any) {
    return this.emitter.on(event, cb);
  }
  once(event: string, cb: any) {
    return this.emitter.once(event, cb);
  }
  emit(event: string, data?: any) {
    return this.emitter.emit(event, data);
  }
}
