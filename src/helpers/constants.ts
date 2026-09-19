export interface IndexConfig {
  symbol: string;
  name: string;
  exchangeSeg: string;
  spotSymbol: string;
  spotToken: string;
  defaultLotSize: number;
  strikeInterval: number;
}

export const INDEX_CONFIGS: Record<string, IndexConfig> = {
  NIFTY: {
    symbol: 'NIFTY',
    name: 'NIFTY',
    exchangeSeg: 'NFO',
    spotSymbol: 'Nifty 50',
    spotToken: '99926000', // NSE Cash index token for Nifty 50
    defaultLotSize: 65,
    strikeInterval: 50,
  }
};

export const ANGEL_API_ENDPOINTS = {
  SCRIP_MASTER: 'https://margincalculator.angelbroking.com/OpenAPI_File/files/OpenAPIScripMaster.json',
  LOGIN: 'https://apiconnect.angelone.in/rest/auth/angelbroking/user/v1/loginByPassword',
  GENERATE_TOKEN: 'https://apiconnect.angelone.in/rest/auth/angelbroking/jwt/v1/generateTokens',
  PROFILE: 'https://apiconnect.angelone.in/rest/secure/angelbroking/user/v1/getProfile',
  LTP: 'https://apiconnect.angelone.in/rest/secure/angelbroking/market/v1/quote',
  ORDER_PLACE: 'https://apiconnect.angelone.in/rest/secure/angelbroking/order/v1/placeOrder',
  ORDER_BOOK: 'https://apiconnect.angelone.in/rest/secure/angelbroking/order/v1/getOrderBook',
  RMS_MARGIN: 'https://apiconnect.angelone.in/rest/secure/angelbroking/user/v1/getRMS',
  WS_STREAM: 'wss://smartapisocket.angelone.in/smart-stream',
};
