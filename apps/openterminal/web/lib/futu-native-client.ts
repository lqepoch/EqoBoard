import net from "node:net";
import crypto from "node:crypto";
import { createRequire } from "node:module";

// 通过 node:module 安全加载 futu-api/proto.js
const require = createRequire(import.meta.url);
let protoRoot: any = null;
try {
  protoRoot = require("futu-api/proto.js");
} catch (e) {
  console.error("Failed to load futu-api/proto.js", e);
}

export type FutuQuoteItem = {
  symbol: string;
  name?: string;
  price: number;
  open: number;
  high: number;
  low: number;
  prevClose: number;
  volume: number;
  turnover?: number;
  updateTime?: string;
};

export type FutuOrderBookEntry = {
  price: number;
  size: number;
  orderCount?: number;
};

export type FutuOrderBook = {
  symbol: string;
  bids: FutuOrderBookEntry[];
  asks: FutuOrderBookEntry[];
  timestamp: string;
};

export type FutuTickerItem = {
  time: string;
  price: number;
  size: number;
  dir: number; // 1=BUY, 2=SELL, 3=NEUTRAL
  turnover?: number;
};

export type FutuBarItem = {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
};

class FutuNativeClient {
  private socket: net.Socket | null = null;
  private host = process.env.FUTU_OPEND_HOST || "127.0.0.1";
  private port = Number(process.env.FUTU_OPEND_PORT || 11111);
  private serialNo = 1;
  private pendingRequests = new Map<number, { resolve: (val: any) => void; reject: (err: any) => void; timer: NodeJS.Timeout }>();
  private connected = false;
  private loginInfo: any = null;
  private recvBuffer = Buffer.alloc(0);
  private keepAliveTimer: NodeJS.Timeout | null = null;
  private subscribedSymbols = new Set<string>();

  constructor() {
    this.connect();
  }

  public isConnected() {
    return this.connected;
  }

  public getLoginInfo() {
    return this.loginInfo;
  }

  private connect() {
    if (this.socket) {
      this.socket.destroy();
      this.socket = null;
    }

    const s = new net.Socket();
    this.socket = s;
    this.connected = false;
    this.recvBuffer = Buffer.alloc(0);

    s.connect(this.port, this.host, () => {
      // 1. 发起握手 InitConnect
      this.send(1001, "InitConnect.Request", {
        c2s: { clientVer: 300, clientID: "eqoboard-web", recvNotify: true }
      }).then((resp: any) => {
        if (resp && resp.retType === 0) {
          this.connected = true;
          this.loginInfo = resp.s2c;
          this.subscribedSymbols.clear();
          this.startKeepAlive();
        } else {
          console.warn("Futu InitConnect rejected:", resp?.retMsg);
        }
      }).catch((err) => {
        console.warn("Futu InitConnect failed:", err);
      });
    });

    s.on("data", (chunk) => {
      this.recvBuffer = Buffer.concat([this.recvBuffer, chunk]);
      while (this.recvBuffer.length >= 44) {
        const bodyLen = this.recvBuffer.readUInt32LE(12);
        if (this.recvBuffer.length < 44 + bodyLen) break;

        const protoId = this.recvBuffer.readUInt32LE(2);
        const serial = this.recvBuffer.readUInt32LE(8);
        const body = this.recvBuffer.subarray(44, 44 + bodyLen);
        this.recvBuffer = this.recvBuffer.subarray(44 + bodyLen);

        const pending = this.pendingRequests.get(serial);
        if (pending) {
          clearTimeout(pending.timer);
          this.pendingRequests.delete(serial);
          try {
            const respType = this.lookupResponseProto(protoId);
            if (respType) {
              const decoded = respType.decode(body);
              pending.resolve(decoded);
            } else {
              pending.resolve({ rawBody: body, protoId });
            }
          } catch (e) {
            pending.reject(e);
          }
        }
      }
    });

    s.on("error", (err) => {
      this.connected = false;
      this.clearPending(err);
    });

    s.on("close", () => {
      this.connected = false;
      this.stopKeepAlive();
      // 5秒后尝试重连
      setTimeout(() => this.connect(), 5000);
    });
  }

  private startKeepAlive() {
    this.stopKeepAlive();
    this.keepAliveTimer = setInterval(() => {
      if (this.connected) {
        this.send(1004, "KeepAlive.Request", { c2s: { time: Math.floor(Date.now() / 1000) } }).catch(() => {});
      }
    }, 10000);
  }

  private stopKeepAlive() {
    if (this.keepAliveTimer) {
      clearInterval(this.keepAliveTimer);
      this.keepAliveTimer = null;
    }
  }

  private clearPending(err: any) {
    for (const [_, p] of this.pendingRequests.entries()) {
      clearTimeout(p.timer);
      p.reject(err);
    }
    this.pendingRequests.clear();
  }

  private lookupResponseProto(protoId: number) {
    if (!protoRoot) return null;
    const map: Record<number, string> = {
      1001: "InitConnect.Response",
      1004: "KeepAlive.Response",
      3001: "Qot_Sub.Response",
      3003: "Qot_GetSubInfo.Response",
      3004: "Qot_GetBasicQot.Response",
      3006: "Qot_GetKL.Response",
      3010: "Qot_GetTicker.Response",
      3012: "Qot_GetOrderBook.Response",
      3103: "Qot_RequestHistoryKL.Response",
      3203: "Qot_GetSecuritySnapshot.Response",
    };
    const name = map[protoId];
    return name ? protoRoot.lookupType(name) : null;
  }

  private send(protoId: number, typeName: string, bodyObj: any): Promise<any> {
    return new Promise((resolve, reject) => {
      if (!this.socket || this.socket.destroyed) {
        return reject(new Error("Futu socket not connected"));
      }

      if (!protoRoot) {
        return reject(new Error("ProtoRoot not loaded"));
      }

      const Type = protoRoot.lookupType(typeName);
      const bodyBuf = Type.encode(bodyObj).finish();
      const sha1 = crypto.createHash("sha1").update(bodyBuf).digest();

      const serial = this.serialNo++;
      const header = Buffer.alloc(44);
      header.write("FT", 0);
      header.writeUInt32LE(protoId, 2);
      header.writeUInt8(0, 6); // Protobuf
      header.writeUInt8(0, 7);
      header.writeUInt32LE(serial, 8);
      header.writeUInt32LE(bodyBuf.length, 12);
      sha1.copy(header, 16);

      const timer = setTimeout(() => {
        this.pendingRequests.delete(serial);
        reject(new Error(`Futu request timeout for proto ${protoId}`));
      }, 8000);

      this.pendingRequests.set(serial, { resolve, reject, timer });
      this.socket.write(Buffer.concat([header, bodyBuf]));
    });
  }

  /**
   * 确保标的已订阅指定类型（默认开启美股全时段盘前盘后与夜盘 extendedTime: true）
   */
  public async ensureSub(symbol: string, subTypes: number[], extendedTime = true) {
    const sym = symbol.toUpperCase();
    const key = `${sym}-${subTypes.join(",")}-${extendedTime}`;
    if (this.subscribedSymbols.has(key)) return;

    try {
      const resp = await this.send(3001, "Qot_Sub.Request", {
        c2s: {
          securityList: [{ market: 11, code: sym }], // 11 = US Market
          subTypeList: subTypes,
          isSubOrUnSub: true,
          isRegOrUnRegPush: true,
          extendedTime,
        }
      });
      if (resp && resp.retType === 0) {
        this.subscribedSymbols.add(key);
      }
    } catch (e) {
      console.warn(`Failed to sub ${sym}:`, e);
    }
  }

  /**
   * 获取证券全时段快照 (含 regular, preMarket, afterMarket, overnight, 52周区间)
   */
  public async getSecuritySnapshot(symbols: string[]) {
    const cleanSymbols = symbols.map((s) => s.toUpperCase());
    await Promise.all(cleanSymbols.map((s) => this.ensureSub(s, [1])));

    const resp = await this.send(3203, "Qot_GetSecuritySnapshot.Request", {
      c2s: {
        securityList: cleanSymbols.map((s) => ({ market: 11, code: s })),
      }
    });

    if (!resp || resp.retType !== 0 || !resp.s2c?.snapshotList) {
      throw new Error(resp?.retMsg || "GetSecuritySnapshot failed");
    }

    return resp.s2c.snapshotList;
  }

  /**
   * 获取多只股票的最新行情快照
   */
  public async getBasicQot(symbols: string[]): Promise<FutuQuoteItem[]> {
    const cleanSymbols = symbols.map((s) => s.toUpperCase());
    // 自动按需订阅 SubType_Basic (1)
    await Promise.all(cleanSymbols.map((s) => this.ensureSub(s, [1])));

    const resp = await this.send(3004, "Qot_GetBasicQot.Request", {
      c2s: {
        securityList: cleanSymbols.map((s) => ({ market: 11, code: s })),
      }
    });

    if (!resp || resp.retType !== 0 || !resp.s2c?.basicQotList) {
      throw new Error(resp?.retMsg || "GetBasicQot failed");
    }

    return resp.s2c.basicQotList.map((q: any) => ({
      symbol: q.security?.code,
      name: q.name || q.security?.code,
      price: q.curPrice || q.lastClosePrice,
      open: q.openPrice || q.lastClosePrice,
      high: q.highPrice || q.curPrice,
      low: q.lowPrice || q.curPrice,
      prevClose: q.lastClosePrice,
      volume: Number(q.volume?.toString() || 0),
      turnover: q.turnover,
      updateTime: q.updateTime,
    }));
  }

  /**
   * 获取某只股票的 Level 2 深度盘口 (10档买卖)
   */
  public async getOrderBook(symbol: string, num = 10): Promise<FutuOrderBook> {
    const sym = symbol.toUpperCase();
    await this.ensureSub(sym, [2]); // SubType_OrderBook = 2

    const resp = await this.send(3012, "Qot_GetOrderBook.Request", {
      c2s: {
        security: { market: 11, code: sym },
        num,
      }
    });

    if (!resp || resp.retType !== 0 || !resp.s2c) {
      throw new Error(resp?.retMsg || "GetOrderBook failed");
    }

    const data = resp.s2c;
    const bids: FutuOrderBookEntry[] = (data.orderBookBidList || []).map((b: any) => ({
      price: b.price,
      size: Number(b.volume?.toString() || 0),
      orderCount: b.orederCount,
    }));
    const asks: FutuOrderBookEntry[] = (data.orderBookAskList || []).map((a: any) => ({
      price: a.price,
      size: Number(a.volume?.toString() || 0),
      orderCount: a.orederCount,
    }));

    return {
      symbol: sym,
      bids,
      asks,
      timestamp: new Date().toISOString(),
    };
  }

  /**
   * 获取逐笔成交 Time & Sales
   */
  public async getTicker(symbol: string, maxRetNum = 25): Promise<FutuTickerItem[]> {
    const sym = symbol.toUpperCase();
    await this.ensureSub(sym, [4]); // SubType_Ticker = 4

    const resp = await this.send(3010, "Qot_GetTicker.Request", {
      c2s: {
        security: { market: 11, code: sym },
        maxRetNum,
      }
    });

    if (!resp || resp.retType !== 0 || !resp.s2c?.tickerList) {
      throw new Error(resp?.retMsg || "GetTicker failed");
    }

    return resp.s2c.tickerList.map((t: any) => ({
      time: t.time || new Date().toISOString(),
      price: t.price,
      size: Number(t.volume?.toString() || 0),
      dir: t.dir, // 1=Buy, 2=Sell, 3=Neutral
      turnover: t.turnover,
    }));
  }

  /**
   * 获取 K 线数据 (1m, 5m, 15m, 60m, 1D, 1W)
   */
  public async getKline(symbol: string, interval: string, reqNum = 120): Promise<FutuBarItem[]> {
    const sym = symbol.toUpperCase();

    // 对应关系:
    // 1m: subType 11, klType 1
    // 5m: subType 7, klType 6
    // 15m: subType 8, klType 7
    // 1h/60m: subType 10, klType 9
    // 1D: subType 6, klType 2
    // 1W: subType 12, klType 3
    let subType = 6;
    let klType = 2;

    if (interval === "1m") { subType = 11; klType = 1; }
    else if (interval === "5m") { subType = 7; klType = 6; }
    else if (interval === "15m") { subType = 8; klType = 7; }
    else if (interval === "1h") { subType = 10; klType = 9; }
    else if (interval === "1W") { subType = 12; klType = 3; }

    await this.ensureSub(sym, [subType]);

    const resp = await this.send(3006, "Qot_GetKL.Request", {
      c2s: {
        rehabType: 1, // 前复权
        klType,
        security: { market: 11, code: sym },
        reqNum,
      }
    });

    if (!resp || resp.retType !== 0 || !resp.s2c?.klList) {
      throw new Error(resp?.retMsg || "GetKL failed");
    }

    return resp.s2c.klList.map((b: any) => {
      // 解析时间戳 (如 '2026-10-12 00:00:00' -> UNIX seconds)
      const t = b.timestamp ? Math.floor(b.timestamp) : Math.floor(Date.parse(b.time) / 1000);
      return {
        time: t,
        open: b.openPrice,
        high: b.highPrice,
        low: b.lowPrice,
        close: b.closePrice,
        volume: Number(b.volume?.toString() || 0),
      };
    }).sort((a: FutuBarItem, b: FutuBarItem) => a.time - b.time);
  }

  /**
   * 查询订阅配额与连接状态
   */
  public async getSubInfo() {
    const resp = await this.send(3003, "Qot_GetSubInfo.Request", { c2s: { isReqAllConn: true } });
    if (!resp || resp.retType !== 0 || !resp.s2c) {
      throw new Error(resp?.retMsg || "GetSubInfo failed");
    }
    return resp.s2c;
  }
}

// 全局单例
export const futuClient = new FutuNativeClient();
