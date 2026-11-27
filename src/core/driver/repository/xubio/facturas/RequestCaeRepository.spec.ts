import type { AxiosInstance } from 'axios';
import {
  RequestCaeRepository,
  XubioCaeRequestError,
} from './RequestCaeRepository';

const ID = 79915082;
const NO_DELAY = {
  maxAttempts: 3,
  initialDelayInMilliseconds: 0,
  maxDelayInMilliseconds: 0,
};

describe('RequestCaeRepository', () => {
  it('asks Xubio for the CAE of one comprobante', async () => {
    const post = jest.fn().mockResolvedValue({
      data: {
        transaccionId: ID,
        CAE: '86484580124007',
        CAEFechaVto: '2026-12-06',
        detalle: '',
      },
    });
    const repository = createRepository(post);

    const result = await repository.requestCae({ transaccionId: ID });

    expect(post).toHaveBeenCalledWith(
      '/API/1.1/solicitarCAE',
      { transaccionId: ID },
      { headers: { Authorization: 'Bearer access-token' } },
    );
    expect(result.cae).toBe('86484580124007');
    expect(result.detail).toBeNull();
  });

  it('reads the reason when Xubio answers without a CAE', async () => {
    const post = jest.fn().mockResolvedValue({
      data: { transaccionId: ID, detalle: ' Rechazado por AFIP: 10016 ' },
    });
    const repository = createRepository(post);

    const result = await repository.requestCae({ transaccionId: ID });

    expect(result.cae).toBeNull();
    expect(result.detail).toBe('Rechazado por AFIP: 10016');
  });

  it('rejects an invalid id before calling Xubio', async () => {
    const post = jest.fn();
    const repository = createRepository(post);

    await expect(
      repository.requestCae({ transaccionId: 0 }),
    ).rejects.toBeInstanceOf(RangeError);
    expect(post).not.toHaveBeenCalled();
  });

  it('never repeats a request whose answer was lost', async () => {
    const post = jest.fn().mockRejectedValue(createTimeoutError());
    const repository = createRepository(post);

    const error = await repository
      .requestCae({ transaccionId: ID })
      .catch((caught: unknown) => caught);

    // AFIP may have granted the CAE: asking again blindly is not an option.
    expect(post).toHaveBeenCalledTimes(1);
    expect(error).toBeInstanceOf(XubioCaeRequestError);
    expect((error as XubioCaeRequestError).outcomeUnknown).toBe(true);
  });

  it.each([500, 502, 504])(
    'treats HTTP %i as an unknown outcome, without repeating',
    async (status) => {
      const post = jest.fn().mockRejectedValue(createAxiosError(status));
      const repository = createRepository(post);

      const error = await repository
        .requestCae({ transaccionId: ID })
        .catch((caught: unknown) => caught);

      expect(post).toHaveBeenCalledTimes(1);
      expect((error as XubioCaeRequestError).outcomeUnknown).toBe(true);
    },
  );

  it('reports a rejection with what Xubio said, as a known outcome', async () => {
    const post = jest.fn().mockRejectedValue(
      createAxiosError(400, {
        error: 'invalid_request',
        description: 'El comprobante anterior no tiene CAE',
      }),
    );
    const repository = createRepository(post);

    const error = await repository
      .requestCae({ transaccionId: ID })
      .catch((caught: unknown) => caught);

    expect(post).toHaveBeenCalledTimes(1);
    expect((error as XubioCaeRequestError).outcomeUnknown).toBe(false);
    expect((error as Error).message).toContain(
      'El comprobante anterior no tiene CAE',
    );
  });
});

function createRepository(post: jest.Mock): RequestCaeRepository {
  return new RequestCaeRepository({
    accessTokenProvider: () => Promise.resolve('access-token'),
    httpClient: { post } as unknown as AxiosInstance,
    retryOptions: NO_DELAY,
  });
}

function createTimeoutError() {
  return {
    isAxiosError: true,
    code: 'ECONNABORTED',
    message: 'timeout of 60000ms exceeded',
    toJSON: () => ({}),
  };
}

function createAxiosError(status: number, data: unknown = { message: 'x' }) {
  return {
    isAxiosError: true,
    message: 'Request failed',
    response: { status, data },
    toJSON: () => ({}),
  };
}
