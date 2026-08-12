import { describe, expect, test } from "bun:test";
import en from "../public/_locales/en/messages.json";
import zhCN from "../public/_locales/zh_CN/messages.json";

describe("guest authentication locale messages", () => {
  test("defines English guest profile and sync actions", () => {
    expect(en.sidebar_guestTitle.message).toBe("Not logged in");
    expect(en.sidebar_guestDescription.message).toBe("Log in or register to sync");
    expect(en.sync_signedOut.message).toBe("Not logged in");
    expect(en.sync_registerNow.message).toBe("Register now");
  });

  test("defines Chinese guest profile and sync actions", () => {
    expect(zhCN.sidebar_guestTitle.message).toBe("未登录");
    expect(zhCN.sidebar_guestDescription.message).toBe("登录或注册以启用同步");
    expect(zhCN.sync_signedOut.message).toBe("未登录");
    expect(zhCN.sync_registerNow.message).toBe("立即注册");
  });
});
