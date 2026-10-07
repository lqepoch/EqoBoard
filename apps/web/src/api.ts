import type {BarsResponse, GatewayStatus, OptionChainResponse, OrderIntent, PreviewResult, StockResponse} from './types';

export const TOKEN_KEY = 'eqoboard:session-token';
export const getToken = () => sessionStorage.getItem(TOKEN_KEY) ?? '';
export const setToken = (value:string) => {
  if (value) sessionStorage.setItem(TOKEN_KEY, value);
  else sessionStorage.removeItem(TOKEN_KEY);
};
export class ApiError extends Error {
  constructor(public status:number, message:string) {super(message);}
}
async function request<T>(path:string, init?:RequestInit):Promise<T> {
  const token = getToken();
  const response = await fetch(path,{
    ...init,
    headers:{
      ...(init?.body ? {'Content-Type':'application/json'} : {}),
      ...(token ? {Authorization:'Bearer '+token} : {}),
      ...init?.headers
    }
  });
  if (!response.ok) {
    const payload = await response.json().catch(()=>null) as {detail?:string}|null;
    throw new ApiError(response.status,payload?.detail ?? 'HTTP '+response.status);
  }
  return response.json() as Promise<T>;
}
export const getStatus = () => request<GatewayStatus>('/api/v1/status');
export const getStocks = (symbols:string[]) => request<StockResponse>(
  '/api/v1/stocks/snapshots?symbols='+encodeURIComponent(symbols.join(',')));
export const getBars = (symbol:string,timeframe:string) => request<BarsResponse>(
  '/api/v1/stocks/bars?symbol='+encodeURIComponent(symbol)+
  '&timeframe='+encodeURIComponent(timeframe)+'&limit=200');
export const getChain = (underlying:string,expiration:string, range?:{gte:number;lte:number}) => {
  const url = new URLSearchParams({underlying,expiration});
  if (range) {url.set('strike_gte',String(range.gte));url.set('strike_lte',String(range.lte));}
  return request<OptionChainResponse>('/api/v1/options/chain?'+url);
};
export const postOptions = (consumer_id:string,symbols:string[]) =>
  request<{active:number;max:number;expires_in_seconds:number}>('/api/v1/subscriptions/options',
    {method:'POST',body:JSON.stringify({consumer_id,symbols})});
export const createWsTicket = () => request<{ticket:string;expires_in_seconds:number}>('/api/v1/auth/ws-ticket',
  {method:'POST',body:'{}'});
export const createPreview = (intent:OrderIntent) =>
  request<{preview:PreviewResult;execution_enabled:boolean}>('/api/v1/orders/preview',
    {method:'POST',body:JSON.stringify(intent)});
export const submitOrder = (preview_id:string) =>
  request<{client_order_id:string;ack:{status:string;broker_order_id?:string}}>('/api/v1/orders/submit',
    {method:'POST',body:JSON.stringify({preview_id,confirm:true})});
