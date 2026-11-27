import type { AxiosInstance } from 'axios';
import {
  GetComprobanteDetailRepository,
  XubioComprobanteDetailRequestError,
  XubioComprobanteNotFoundError,
} from './GetComprobanteDetailRepository';
import {
  createComprobanteSummary,
  createReference,
} from './GetComprobantesByDateRepository.spec';
import { XubioComprobanteInvalidResponseError } from './XubioComprobanteParsers';

describe('GetComprobanteDetailRepository', () => {
  it('gets Xubio comprobante detail by transaction id', async () => {
    const get = jest.fn().mockResolvedValue({
      data: createComprobanteDetail(),
    });
    const repository = new GetComprobanteDetailRepository({
      httpClient: { get } as unknown as AxiosInstance,
    });

    const result = await repository.getDetail({ transaccionId: 54231396 });

    expect(get).toHaveBeenCalledWith('/API/1.1/comprobanteVentaBean/54231396', {
      headers: {},
    });
    expect(result.comprobante.transaccionid).toBe(54231396);
    expect(result.comprobante.transaccionProductoItems).toHaveLength(2);
    expect(result.comprobante.transaccionCobranzaItems).toHaveLength(1);
  });

  it('rejects invalid detail responses', async () => {
    const response = createComprobanteDetail();
    response.transaccionProductoItems = undefined as unknown as [];
    const get = jest.fn().mockResolvedValue({ data: response });
    const repository = new GetComprobanteDetailRepository({
      httpClient: { get } as unknown as AxiosInstance,
    });

    await expect(
      repository.getDetail({ transaccionId: 54231396 }),
    ).rejects.toBeInstanceOf(XubioComprobanteInvalidResponseError);
  });

  it('does not leak Axios errors outside the driver', async () => {
    const get = jest.fn().mockRejectedValue(new Error('raw network error'));
    const repository = new GetComprobanteDetailRepository({
      httpClient: { get } as unknown as AxiosInstance,
    });

    await expect(
      repository.getDetail({ transaccionId: 54231396 }),
    ).rejects.toEqual(
      new XubioComprobanteDetailRequestError(54231396, 'raw network error'),
    );
  });

  it('refreshes the token and retries after an authorization failure', async () => {
    const get = jest
      .fn()
      .mockRejectedValueOnce(createAxiosError(401))
      .mockResolvedValueOnce({
        data: createComprobanteDetail(),
      });
    const accessTokenProvider = jest
      .fn()
      .mockResolvedValueOnce('token-1')
      .mockResolvedValueOnce('token-2');
    const onAuthorizationFailure = jest.fn();
    const repository = new GetComprobanteDetailRepository({
      httpClient: { get } as unknown as AxiosInstance,
      accessTokenProvider,
      onAuthorizationFailure,
      retryOptions: {
        maxAttempts: 2,
        initialDelayInMilliseconds: 0,
        maxDelayInMilliseconds: 0,
      },
    });

    const result = await repository.getDetail({ transaccionId: 54231396 });

    expect(result.comprobante.transaccionid).toBe(54231396);
    expect(onAuthorizationFailure).toHaveBeenCalledTimes(1);
    expect(accessTokenProvider).toHaveBeenCalledTimes(2);
    expect(get).toHaveBeenNthCalledWith(
      1,
      '/API/1.1/comprobanteVentaBean/54231396',
      {
        headers: {
          Authorization: 'Bearer token-1',
        },
      },
    );
    expect(get).toHaveBeenNthCalledWith(
      2,
      '/API/1.1/comprobanteVentaBean/54231396',
      {
        headers: {
          Authorization: 'Bearer token-2',
        },
      },
    );
  });

  describe('a comprobante deleted in Xubio', () => {
    // What Xubio answers for 79961340, deleted after it was issued: a
    // business error dressed as a 401, with its Java stack trace attached.
    const deletedBody = (description: string) => ({
      cause: null,
      stackTrace: [{ methodName: 'facturaVentaNXVVOToFacturaVentaBean' }],
      error_numero: 0,
      error: 'invalid_request',
      description,
      codeResponse: '406',
      message: description,
      suppressed: [],
    });
    const failWith = (data: unknown) =>
      new GetComprobanteDetailRepository({
        httpClient: {
          get: jest.fn().mockRejectedValue({
            isAxiosError: true,
            message: 'Request failed',
            response: { status: 401, data },
            toJSON: () => ({}),
          }),
        } as unknown as AxiosInstance,
        retryOptions: { maxAttempts: 1 },
      });

    it('is reported as not found, apart from any other failure', async () => {
      const error: unknown = await failWith(
        deletedBody('La Factura de Venta no existe'),
      )
        .getDetail({ transaccionId: 79961340 })
        .catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(XubioComprobanteNotFoundError);
      expect((error as XubioComprobanteNotFoundError).notFound).toBe(true);
      expect((error as Error).message).toBe(
        'Xubio request failed while getting comprobante detail 79961340: no existe en Xubio (fue eliminado)',
      );
    });

    it('is not what any other business error means', async () => {
      const error: unknown = await failWith(
        deletedBody('El cliente de la Factura de Venta no existe en el padrón'),
      )
        .getDetail({ transaccionId: 79961340 })
        .catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(XubioComprobanteDetailRequestError);
      expect(error).not.toBeInstanceOf(XubioComprobanteNotFoundError);
    });

    it('is not assumed from a bare 401 or 404', async () => {
      for (const data of [{ error: 'invalid_token' }, 'Not Found', undefined]) {
        const error: unknown = await failWith(data)
          .getDetail({ transaccionId: 79961340 })
          .catch((caught: unknown) => caught);

        expect(error).not.toBeInstanceOf(XubioComprobanteNotFoundError);
      }
    });

    it('keeps the Java stack trace out of the error message', async () => {
      const error: unknown = await failWith(
        deletedBody('La fecha del comprobante es inválida'),
      )
        .getDetail({ transaccionId: 79961340 })
        .catch((caught: unknown) => caught);

      expect((error as Error).message).toContain(
        'La fecha del comprobante es inválida',
      );
      expect((error as Error).message).not.toContain('stackTrace');
    });
  });

  it('accepts cobranza items without a positive cuentaId', async () => {
    const detail = createComprobanteDetail();
    detail.transaccionCobranzaItems[0].cuentaId = 0;
    const get = jest.fn().mockResolvedValue({
      data: detail,
    });
    const repository = new GetComprobanteDetailRepository({
      httpClient: { get } as unknown as AxiosInstance,
    });

    const result = await repository.getDetail({ transaccionId: 54231396 });

    expect(result.comprobante.transaccionCobranzaItems[0]?.cuentaId).toBe(0);
  });

  it('accepts old Xubio details without descripcion', async () => {
    const detail = createComprobanteDetail();
    delete (detail as Record<string, unknown>).descripcion;
    detail.transaccionProductoItems[0].descripcion = null as unknown as string;
    detail.transaccionCobranzaItems[0].descripcion = null as unknown as string;
    const get = jest.fn().mockResolvedValue({
      data: detail,
    });
    const repository = new GetComprobanteDetailRepository({
      httpClient: { get } as unknown as AxiosInstance,
    });

    const result = await repository.getDetail({ transaccionId: 54231396 });

    expect(result.comprobante.descripcion).toBe('');
    expect(result.comprobante.transaccionProductoItems[0]?.descripcion).toBe(
      '',
    );
    expect(result.comprobante.transaccionCobranzaItems[0]?.descripcion).toBe(
      '',
    );
  });
});

function createAxiosError(status: number) {
  return {
    isAxiosError: true,
    message: 'Request failed',
    response: {
      status,
      data: {
        message: 'temporary Xubio error',
      },
    },
    toJSON: () => ({}),
  };
}

function createComprobanteDetail() {
  return {
    ...createComprobanteSummary(),
    externalId: '',
    cotizacionListaDePrecio: 1,
    transaccionProductoItems: [
      {
        transaccionCVItemId: 65201111,
        importe: 1657000,
        descripcion: '',
        cantidad: 1,
        precio: 1657000,
        producto: createReference(
          2461025,
          'PAGOS_POR_CUENTA_Y_ORDEN',
          'Pagos por cuenta y orden',
        ),
        deposito: createReference(
          -2,
          'DEPOSITO_UNIVERSAL',
          'Depósito Universal',
        ),
        iva: 0,
        total: 1657000,
        precioconivaincluido: 1657000,
        montoExento: 0,
        porcentajeDescuento: 0,
        transaccionId: 54231396,
      },
      {
        transaccionCVItemId: 65201112,
        importe: -324774.99,
        descripcion: '',
        cantidad: 1,
        precio: -324774.99,
        producto: createReference(
          2461081,
          'FLETE_INTERNACIONAL',
          'Flete internacional ',
        ),
        deposito: createReference(
          -2,
          'DEPOSITO_UNIVERSAL',
          'Depósito Universal',
        ),
        iva: 0,
        total: -324774.99,
        precioconivaincluido: -324774.99,
        montoExento: 0,
        porcentajeDescuento: 0,
        transaccionId: 54231396,
      },
    ],
    transaccionPercepcionItems: [],
    transaccionCobranzaItems: [
      {
        transaccionid: 54231396,
        itemId: 194515306,
        cuentaTipo: '2',
        cuentaId: 711036,
        moneda: createReference(-2, 'PESOS_ARGENTINOS', 'Pesos Argentinos'),
        cotizacionMonTransaccion: 1,
        importeMonPrincipal: 1332225.01,
        importeMonTransaccion: 1332225.01,
        descripcion: '',
      },
    ],
  };
}
