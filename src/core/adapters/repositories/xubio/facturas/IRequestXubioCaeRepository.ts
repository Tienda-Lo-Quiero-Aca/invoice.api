export interface RequestXubioCaeCommand {
  transaccionId: number;
}

export interface RequestXubioCaeResponse {
  transaccionId: number;
  cae: string | null;
  /** Whatever Xubio put in `detalle`: usually AFIP's reason when it refuses. */
  detail: string | null;
  rawPayload: unknown;
}

export interface IRequestXubioCaeRepository {
  requestCae(command: RequestXubioCaeCommand): Promise<RequestXubioCaeResponse>;
}
