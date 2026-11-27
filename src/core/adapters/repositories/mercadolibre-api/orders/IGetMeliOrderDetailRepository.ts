import type {
  GetMeliOrderDetailCommand,
  GetMeliOrderDetailResponse,
} from '../../../../entities/mercadolibre/orders/MeliOrderDetail';

export interface IGetMeliOrderDetailRepository {
  getByOrderId(
    command: GetMeliOrderDetailCommand,
  ): Promise<GetMeliOrderDetailResponse>;
}
