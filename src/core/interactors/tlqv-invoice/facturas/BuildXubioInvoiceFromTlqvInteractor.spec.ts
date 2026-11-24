import type { MadreItem } from '../../../entities/spreadsheet-api/madre/MadreItems';
import type { TlqvItem } from '../../../entities/spreadsheet-api/tlqv/TlqvItems';
import {
  BuildXubioInvoiceFromTlqvInteractor,
  computeExpectedInvoiceTotal,
} from './BuildXubioInvoiceFromTlqvInteractor';

describe('BuildXubioInvoiceFromTlqvInteractor', () => {
  it('builds an A invoice using net values', () => {
    const result = new BuildXubioInvoiceFromTlqvInteractor().execute({
      tlqvCode: 'TLQV-15713',
      customerId: 10329110,
      fiscalCondition: 'RESPONSABLE INSCRIPTO',
      issueDate: '2026-07-30',
      tlqvSheetItem: createTlqvItem({
        Productoco: '204576.80',
        DIFACTURA: '0.00',
        TEFACTURA: '0.00',
        IVAFACTURA: '20014.56',
        LAFACTURA: '21280.00',
        'LAFACTURA.B': '25748.80',
        FLETEINTERNACIONALA: '326354.12',
        'Comisiones externas': '210,834.72',
        'Flete doméstico': '7,470.00',
      }),
      madreSheetItem: createMadreItem({
        NROVENTA: '2000017369931210',
      }),
    });

    expect(result.invoiceLetter.letter).toBe('A');
    expect(result.invoice.description).toBe('TLQV-15713 ML: 2000017369931210');
    expect(result.invoice.items).toEqual([
      expect.objectContaining({
        productId: 2461025,
        unitPrice: 204576.8,
        priceWithVat: 0,
      }),
      expect.objectContaining({
        productId: 2461066,
        unitPrice: 20014.56,
        priceWithVat: 0,
      }),
      expect.objectContaining({
        productId: 2461080,
        unitPrice: 21280,
        priceWithVat: 0,
      }),
      expect.objectContaining({
        productId: 2460999,
        unitPrice: 174243.57,
        priceWithVat: 0,
      }),
      expect.objectContaining({
        productId: 2461000,
        unitPrice: 6173.55,
        priceWithVat: 0,
      }),
      expect.objectContaining({
        productId: 2461081,
        unitPrice: 326354.12,
        priceWithVat: 0,
      }),
    ]);
    expect(result.itemMappings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          productId: 2461058,
          skipped: true,
          skippedReason: 'zero_or_empty_amount',
        }),
        expect.objectContaining({
          productId: 2461065,
          skipped: true,
          skippedReason: 'zero_or_empty_amount',
        }),
      ]),
    );
  });

  it('matches a real Xubio A invoice: DI/TE sent as-is (no VAT divisor) and Impuestos Internos multiplied by tc impuesto (TLQV-16887)', () => {
    const result = new BuildXubioInvoiceFromTlqvInteractor().execute({
      tlqvCode: 'TLQV-16887',
      customerId: 9557555,
      fiscalCondition: 'RESPONSABLE INSCRIPTO',
      issueDate: '2026-08-20',
      tlqvSheetItem: createTlqvItem({
        Productoco: '943046.00',
        DIFACTURA: '63083.97',
        TEFACTURA: '9461.85',
        IVAFACTURA: '215298.21',
        'Imp Internos': '93.30',
        'tc impuesto': '1499.50',
        LAFACTURA: '21280.00',
        'LAFACTURA.B': '25748.80',
        FLETEINTERNACIONALA: '1795507.33',
        'Comisiones externas': '0',
        'Flete doméstico': '0',
      }),
      madreSheetItem: createMadreItem({
        NROVENTA: '2000017655168916',
      }),
    });

    expect(result.invoiceLetter.letter).toBe('A');
    expect(result.itemMappings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          productId: 2461058,
          sourceField: 'DIFACTURA',
          amount: 63083.97,
          skipped: false,
        }),
        expect.objectContaining({
          productId: 2461065,
          sourceField: 'TEFACTURA',
          amount: 9461.85,
          skipped: false,
        }),
        expect.objectContaining({
          productId: 2826655,
          sourceField: 'Imp Internos',
          multiplierField: 'tc impuesto',
          multiplierValue: 1499.5,
          amount: 139903.35,
          skipped: false,
        }),
      ]),
    );
    expect(result.invoice.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          productId: 2461058,
          unitPrice: 63083.97,
          priceWithVat: 0,
        }),
        expect.objectContaining({
          productId: 2461065,
          unitPrice: 9461.85,
          priceWithVat: 0,
        }),
        expect.objectContaining({
          productId: 2826655,
          unitPrice: 139903.35,
          priceWithVat: 0,
        }),
      ]),
    );
  });

  it('skips Impuestos Internos when the TLQV sheet does not have that value', () => {
    const result = new BuildXubioInvoiceFromTlqvInteractor().execute({
      tlqvCode: 'TLQV-14921',
      customerId: 10329110,
      fiscalCondition: 'RESPONSABLE INSCRIPTO',
      issueDate: '2026-07-30',
      tlqvSheetItem: createTlqvItem({
        Productoco: '204576.80',
        'tc impuesto': '1499.50',
      }),
      madreSheetItem: createMadreItem({ NROVENTA: '2000017369931210' }),
    });

    expect(result.itemMappings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          productId: 2826655,
          skipped: true,
          skippedReason: 'zero_or_empty_amount',
        }),
      ]),
    );
  });

  it('counts the 21% VAT Xubio adds to Gastos documentales Aduana in the expected A total, while sending it net (TLQV-18860)', () => {
    const result = new BuildXubioInvoiceFromTlqvInteractor().execute({
      tlqvCode: 'TLQV-18860',
      customerId: 10441659,
      fiscalCondition: 'MONOTRIBUTO',
      issueDate: '2026-08-31',
      tlqvSheetItem: createTlqvItem({
        Productoco: '0.00',
        DIFACTURA: '102204.04',
        TEFACTURA: '8763.80',
        IVAFACTURA: '228916.50',
        LAFACTURA: '21420.00',
        'LAFACTURA.B': '25918.20',
        FLETEINTERNACIONALA: '2100507.46',
        'Comisiones externas': '406,280.00',
        'Flete doméstico': '29,410.00',
      }),
      madreSheetItem: createMadreItem({
        NROVENTA: '2000018197302938',
      }),
    });

    const gastosDocumentales = result.itemMappings.find(
      (mapping) => mapping.productId === 2461080,
    );

    // Sent net — byte-for-byte what Xubio received before this fix.
    expect(gastosDocumentales?.amount).toBe(21420);
    // Counted gross, because Xubio adds the 21% back on the letter A invoice.
    expect(gastosDocumentales?.grossAmount).toBe(25918.2);
    expect(
      result.invoice.items.find((item) => item.productId === 2461080),
    ).toEqual(expect.objectContaining({ unitPrice: 21420, priceWithVat: 0 }));

    // "Precio de venta" in costos-operaciones for TLQV-18860.
    expect(computeExpectedInvoiceTotal(result.itemMappings)).toBe(2902000);
  });

  it('adds Flete U.S.A. and Seguro Internacional to an A invoice from the A columns (TLQV-22280)', () => {
    const result = new BuildXubioInvoiceFromTlqvInteractor().execute({
      tlqvCode: 'TLQV-22280',
      customerId: 10441659,
      fiscalCondition: 'RESPONSABLE INSCRIPTO',
      issueDate: '2026-11-24',
      tlqvSheetItem: createTlqvItem(TLQV_22280_SHEET),
      madreSheetItem: createMadreItem(TLQV_22280_MADRE),
    });

    // Flete U.S.A. is not taxed: column A as it comes.
    expect(
      result.invoice.items.find((item) => item.productId === 3464973),
    ).toEqual(
      expect.objectContaining({
        description: 'Flete U.S.A.',
        unitPrice: 3785.99,
        priceWithVat: 0,
      }),
    );

    // Seguro Internacional: SEGUROINTA as it comes, already net of VAT. The
    // product is taxed at 21%, so Xubio adds it and the total check counts it.
    const seguro = result.itemMappings.find(
      (mapping) => mapping.productId === 3464974,
    );
    expect(seguro?.sourceField).toBe('SEGUROINTA');
    expect(seguro?.rawValue).toBe('1978.51');
    expect(seguro?.amount).toBe(1978.51);
    expect(seguro?.grossAmount).toBeCloseTo(2394, 2);
    expect(
      result.invoice.items.find((item) => item.productId === 3464974),
    ).toEqual(
      expect.objectContaining({
        description: 'Seguro Internacional',
        unitPrice: 1978.51,
        priceWithVat: 0,
      }),
    );

    // "Precio de venta" in costos-operaciones is $1,309,000.00. Without the
    // two concepts the total fell $6,179.99 short and the invoice was blocked;
    // without counting the VAT of the seguro it still fell $415.49 short.
    expect(computeExpectedInvoiceTotal(result.itemMappings)).toBe(1309000.01);
  });

  it('adds Flete U.S.A. and Seguro Internacional to a B invoice from the B columns (TLQV-22280)', () => {
    const result = new BuildXubioInvoiceFromTlqvInteractor().execute({
      tlqvCode: 'TLQV-22280',
      customerId: 10441659,
      fiscalCondition: 'CONSUMIDOR FINAL',
      issueDate: '2026-11-24',
      tlqvSheetItem: createTlqvItem(TLQV_22280_SHEET),
      madreSheetItem: createMadreItem(TLQV_22280_MADRE),
    });

    expect(
      result.invoice.items.find((item) => item.productId === 3464973),
    ).toEqual(
      expect.objectContaining({
        description: 'Flete U.S.A.',
        unitPrice: 3785.99,
        priceWithVat: 3785.99,
      }),
    );
    expect(
      result.invoice.items.find((item) => item.productId === 3464974),
    ).toEqual(
      expect.objectContaining({
        description: 'Seguro Internacional',
        unitPrice: 2394,
        priceWithVat: 2394,
      }),
    );
    expect(computeExpectedInvoiceTotal(result.itemMappings)).toBe(1309000.01);
  });

  it('reads Comisiones externas and Fletes domesticos from the TLQV sheet, where the commission includes the cuotas cost (TLQV-22284)', () => {
    const result = new BuildXubioInvoiceFromTlqvInteractor().execute({
      tlqvCode: 'TLQV-22284',
      customerId: 10441659,
      fiscalCondition: 'RESPONSABLE INSCRIPTO',
      issueDate: '2026-11-24',
      tlqvSheetItem: createTlqvItem({
        Productoco: '103833.40',
        IVAFACTURA: '19983.32',
        'LAFACTURA.B': '4672.71',
        FLETEINTERNACIONALA: '43909.62',
        FLETEUSAA: '3785.99',
        SEGUROINTA: '663.84',
        SEGUROINTB: '803.25',
        'Comisiones externas': '43,990.15',
        'Flete doméstico': '18,359.90',
      }),
      // MADRE still carries the old columns for this sale, without the
      // $33,883.13 of cuotas. They must not be read any more.
      madreSheetItem: createMadreItem({
        NROVENTA: '2000019120000000',
        COMISIONML: '$10,107.02',
        COSTOENVIO: '$7,500.00',
      }),
    });

    const comisiones = result.itemMappings.find(
      (mapping) => mapping.productId === 2460999,
    );
    expect(comisiones?.sourceSheet).toBe('TLQV');
    expect(comisiones?.grossAmount).toBe(43990.15);
    // Letter A keeps the same logic as before: sent net of the 21%.
    expect(comisiones?.amount).toBe(36355.5);

    const fletes = result.itemMappings.find(
      (mapping) => mapping.productId === 2461000,
    );
    expect(fletes?.sourceSheet).toBe('TLQV');
    expect(fletes?.amount).toBe(15173.47);

    // "Precio de venta" in costos-operaciones is $239,338.33. Read from MADRE
    // this fell $44,743 short and the invoice was blocked.
    expect(computeExpectedInvoiceTotal(result.itemMappings)).toBe(239338.34);
  });

  it('leaves both concepts out when the sheet has them empty, as on TLQVs loaded before the columns existed', () => {
    const result = new BuildXubioInvoiceFromTlqvInteractor().execute({
      tlqvCode: 'TLQV-22310',
      customerId: 10441659,
      fiscalCondition: 'RESPONSABLE INSCRIPTO',
      issueDate: '2026-11-24',
      tlqvSheetItem: createTlqvItem({
        Productoco: '135340.30',
        FLETEINTERNACIONALA: '178793.92',
        FLETEUSAA: '',
        FLETEUSAB: '',
        SEGUROINTA: '',
        SEGUROINTB: '',
      }),
      madreSheetItem: createMadreItem(),
    });

    expect(result.invoice.items.map((item) => item.productId)).toEqual([
      2461025, 2461081,
    ]);
  });

  it('builds a B invoice using VAT-included values', () => {
    const result = new BuildXubioInvoiceFromTlqvInteractor().execute({
      tlqvCode: 'TLQV-15738',
      customerId: 10329108,
      fiscalCondition: 'CONSUMIDOR FINAL',
      issueDate: '2026-07-30',
      tlqvSheetItem: createTlqvItem({
        Productoco: '139824.80',
        'DIFACTURA.B': '0.00',
        'TEFACTURA.B': '0.00',
        IVAFACTURA: '28513.22',
        'LAFACTURA.B': '25748.80',
        FLETEINTERNACIONALB: '118403.82',
        'Comisiones externas': '126,288.52',
        'Flete doméstico': '7,470.00',
      }),
      madreSheetItem: createMadreItem({
        NROVENTA: '2000017380549140',
      }),
    });

    expect(result.invoiceLetter.letter).toBe('B');
    expect(result.invoice.items).toEqual([
      expect.objectContaining({
        productId: 2461025,
        unitPrice: 139824.8,
        priceWithVat: 139824.8,
      }),
      expect.objectContaining({
        productId: 2461066,
        unitPrice: 28513.22,
        priceWithVat: 28513.22,
      }),
      expect.objectContaining({
        productId: 2461080,
        unitPrice: 25748.8,
        priceWithVat: 25748.8,
      }),
      expect.objectContaining({
        productId: 2460999,
        unitPrice: 126288.52,
        priceWithVat: 126288.52,
      }),
      expect.objectContaining({
        productId: 2461000,
        unitPrice: 7470,
        priceWithVat: 7470,
      }),
      expect.objectContaining({
        productId: 2461081,
        unitPrice: 118403.82,
        priceWithVat: 118403.82,
      }),
    ]);
  });
});

// TLQV-22280 as it is in the TLQV and MADRE sheets.
const TLQV_22280_SHEET = {
  Productoco: '311742.68',
  IVAFACTURA: '61696.36',
  LAFACTURA: '3861.74',
  'LAFACTURA.B': '4672.71',
  FLETEINTERNACIONALA: '720668.27',
  FLETEINTERNACIONALB: '720668.27',
  FLETEUSAA: '3785.99',
  FLETEUSAB: '3785.99',
  SEGUROINTA: '1978.51',
  SEGUROINTB: '2394.00',
  'Comisiones externas': '188,850.00',
  'Flete doméstico': '15,190.00',
};

const TLQV_22280_MADRE = {
  NROVENTA: '2000019101982438',
};

function createTlqvItem(overrides: Partial<TlqvItem['data']> = {}): TlqvItem {
  return {
    rowNumber: 10,
    data: {
      TLQV: 'TLQV-15713',
      'Valor Declarado': '0',
      Peso: '0',
      PESOVOLUMENTICO: '0',
      VALORXKG: '0',
      DI: '0',
      TE: '0',
      IVA: '0',
      'Total Impuestos': '0',
      'Total Flete': '0',
      'Fijo Liberacion': '0',
      Seguro: '0',
      Total: '0',
      tc: '0',
      tc2: '0',
      'tc impuesto': '0',
      Productoco: '0',
      'Productoco.b': '0',
      DIFACTURA: '0',
      'DIFACTURA.B': '0',
      TEFACTURA: '0',
      'TEFACTURA.B': '0',
      IVAFACTURA: '0',
      'IVAFACTURA.B': '0',
      LAFACTURA: '0',
      'LAFACTURA.B': '0',
      A13VENTA: '0',
      FLETEINTERNACIONALA: '0',
      FLETEINTERNACIONALB: '0',
      'NRO CARGA': '',
      ...overrides,
    },
  };
}

function createMadreItem(
  overrides: Partial<MadreItem['data']> = {},
): MadreItem {
  return {
    rowNumber: 20,
    data: {
      Identificador: 'TLQV-15713',
      NROVENTA: '',
      ...overrides,
    },
  };
}
