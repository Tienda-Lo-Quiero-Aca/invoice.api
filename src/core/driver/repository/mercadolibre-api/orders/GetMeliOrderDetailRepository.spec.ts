import type { AxiosInstance } from 'axios';
import {
  GetMeliOrderDetailRepository,
  MeliOrderDetailConfigurationError,
  MeliOrderDetailInvalidResponseError,
  MeliOrderDetailRequestError,
} from './GetMeliOrderDetailRepository';

describe('GetMeliOrderDetailRepository', () => {
  it('gets one sale and keeps what invoicing needs (order 2000019813708728)', async () => {
    const get = jest.fn().mockResolvedValue({ data: createApiResponse() });
    const repository = createRepository(get);

    const result = await repository.getByOrderId({
      orderId: ' 2000019813708728 ',
    });

    expect(get).toHaveBeenCalledWith('/meli/orders/2000019813708728', {
      headers: {
        Accept: 'application/json',
        'x-internal-api-key': 'una-clave',
      },
    });
    if (!result.found) {
      throw new Error('Expected the order to be found');
    }
    expect(result.order).toEqual({
      id: '2000019813708728',
      packId: '2000016292307607',
      status: 'paid',
      currencyId: 'ARS',
      totalAmount: 386749.16,
      paidAmount: 386749.16,
      items: [
        {
          itemId: 'MLA1694487515',
          title:
            'Cámara De Acción 4k 30fps Go11-us, Portátil Para Vlogging, I Color',
          sellerSku: 'B0FPQ5PRP9',
          quantity: 1,
          unitPrice: 386749.16,
        },
      ],
      billing: {
        firstName: 'Dante Daniel',
        lastName: 'Castro',
        identificationType: 'DNI',
        identificationNumber: '24574352',
        taxpayerTypeDescription: 'Consumidor Final',
        address: {
          streetName: 'Avenida 2 de Abril',
          streetNumber: '3449',
          cityName: 'San Salvador de Jujuy',
          stateName: 'Jujuy',
          zipCode: '4604',
        },
      },
      rawPayload: createApiResponse(),
    });
  });

  it('returns the sale without billing when Mercado Libre did not report it', async () => {
    const get = jest.fn().mockResolvedValue({
      data: { ...createApiResponse(), buyer: { id: 1, billing: null } },
    });

    const result = await createRepository(get).getByOrderId({
      orderId: '2000019813708728',
    });

    expect(result.found && result.order.billing).toBeNull();
  });

  it('returns not found on HTTP 404', async () => {
    const get = jest.fn().mockRejectedValue({
      isAxiosError: true,
      response: { status: 404, data: { message: 'Order not found' } },
    });

    const result = await createRepository(get).getByOrderId({ orderId: '1' });

    expect(result).toEqual({
      found: false,
      orderId: '1',
      rawPayload: { message: 'Order not found' },
    });
  });

  it('rejects an answer for another order', async () => {
    const get = jest.fn().mockResolvedValue({ data: createApiResponse() });

    await expect(
      createRepository(get).getByOrderId({ orderId: '2000019813708999' }),
    ).rejects.toBeInstanceOf(MeliOrderDetailInvalidResponseError);
  });

  it('rejects an answer without an amount, rather than billing zero', async () => {
    const get = jest.fn().mockResolvedValue({
      data: { ...createApiResponse(), totalAmount: null },
    });

    await expect(
      createRepository(get).getByOrderId({ orderId: '2000019813708728' }),
    ).rejects.toThrow('totalAmount must be a number');
  });

  it('wraps request failures with context', async () => {
    const get = jest.fn().mockRejectedValue({
      isAxiosError: true,
      code: 'ECONNABORTED',
      message: 'timeout of 30000ms exceeded',
    });

    await expect(
      createRepository(get).getByOrderId({ orderId: '2000019813708728' }),
    ).rejects.toEqual(
      new MeliOrderDetailRequestError(
        '2000019813708728',
        'ECONNABORTED - timeout of 30000ms exceeded',
      ),
    );
  });

  it('fails clearly when the internal API key is not configured', async () => {
    const get = jest.fn();
    const repository = new GetMeliOrderDetailRepository({
      httpClient: { get } as unknown as AxiosInstance,
    });

    await expect(
      repository.getByOrderId({ orderId: '2000019813708728' }),
    ).rejects.toBeInstanceOf(MeliOrderDetailConfigurationError);
    expect(get).not.toHaveBeenCalled();
  });

  it('rejects an order id that is not numeric', async () => {
    await expect(
      createRepository(jest.fn()).getByOrderId({ orderId: '../packs/1' }),
    ).rejects.toThrow('orderId must be numeric');
  });
});

function createRepository(get: jest.Mock): GetMeliOrderDetailRepository {
  return new GetMeliOrderDetailRepository({
    internalApiKey: 'una-clave',
    httpClient: { get } as unknown as AxiosInstance,
  });
}

function createApiResponse() {
  return {
    id: 2000019813708728,
    packId: 2000016292307607,
    status: 'paid',
    statusDetail: null,
    currencyId: 'ARS',
    totalAmount: 386749.16,
    paidAmount: 386749.16,
    items: [
      {
        itemId: 'MLA1694487515',
        title:
          'Cámara De Acción 4k 30fps Go11-us, Portátil Para Vlogging, I Color',
        categoryId: 'MLA392132',
        sellerSku: 'B0FPQ5PRP9',
        quantity: 1,
        unitPrice: 386749.16,
        grossPrice: 453999,
        saleFee: 59946.12,
      },
    ],
    buyer: {
      id: 80921592,
      nickname: 'DANI_CASTROAR',
      billing: {
        firstName: 'Dante Daniel',
        lastName: 'Castro',
        identificationType: 'DNI',
        identificationNumber: '24574352',
        taxpayerType: { id: '05', description: 'Consumidor Final' },
        customerType: 'CO',
        address: {
          streetName: 'Avenida 2 de Abril',
          streetNumber: '3449',
          cityName: 'San Salvador de Jujuy',
          stateCode: 'AR-Y',
          stateName: 'Jujuy',
          zipCode: '4604',
          countryId: 'AR',
        },
      },
    },
    shipping: { id: 48648448328, costs: { buyerCost: 0, sellerCost: 8290 } },
  };
}
