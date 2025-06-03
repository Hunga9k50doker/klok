const fs = require("fs");
const path = require("path");
const axios = require("axios");
const colors = require("colors");
const { HttpsProxyAgent } = require("https-proxy-agent");
const readline = require("readline");
const user_agents = require("./config/userAgents");
const settings = require("./config/config.js");
const { sleep, loadData, getRandomNumber, saveToken, isTokenExpired, saveJson, updateEnv, decodeJWT, getRandomElement, generateRandomEmail } = require("./utils/utils.js");
const { Worker, isMainThread, parentPort, workerData } = require("worker_threads");
const { checkBaseUrl } = require("./utils/checkAPI");
const { headers } = require("./core/header.js");
const { showBanner } = require("./core/banner.js");
const localStorage = require("./localStorage.json");
const { v4: uuidv4 } = require("uuid");
const { Wallet, ethers } = require("ethers");
const { solveCaptcha } = require("./utils/captcha.js");
const questions = loadData("questions.txt");
const events = require("./events.json");

class ClientAPI {
  constructor(itemData, accountIndex, proxy, baseURL) {
    this.headers = headers;
    this.baseURL = baseURL;
    this.itemData = itemData;
    this.accountIndex = accountIndex;
    this.proxy = proxy;
    this.proxyIP = null;
    this.session_name = null;
    this.session_user_agents = this.#load_session_data();
    this.token = null;
    this.localStorage = localStorage;
    this.wallet = new ethers.Wallet(this.itemData.privateKey);
  }

  #load_session_data() {
    try {
      const filePath = path.join(process.cwd(), "session_user_agents.json");
      const data = fs.readFileSync(filePath, "utf8");
      return JSON.parse(data);
    } catch (error) {
      if (error.code === "ENOENT") {
        return {};
      } else {
        throw error;
      }
    }
  }

  #get_random_user_agent() {
    const randomIndex = Math.floor(Math.random() * user_agents.length);
    return user_agents[randomIndex];
  }

  #get_user_agent() {
    if (this.session_user_agents[this.session_name]) {
      return this.session_user_agents[this.session_name];
    }

    console.log(`[Tài khoản ${this.accountIndex + 1}] Tạo user agent...`.blue);
    const newUserAgent = this.#get_random_user_agent();
    this.session_user_agents[this.session_name] = newUserAgent;
    this.#save_session_data(this.session_user_agents);
    return newUserAgent;
  }

  #save_session_data(session_user_agents) {
    const filePath = path.join(process.cwd(), "session_user_agents.json");
    fs.writeFileSync(filePath, JSON.stringify(session_user_agents, null, 2));
  }

  #get_platform(userAgent) {
    const platformPatterns = [
      { pattern: /iPhone/i, platform: "ios" },
      { pattern: /Android/i, platform: "android" },
      { pattern: /iPad/i, platform: "ios" },
    ];

    for (const { pattern, platform } of platformPatterns) {
      if (pattern.test(userAgent)) {
        return platform;
      }
    }

    return "Unknown";
  }

  #set_headers() {
    const platform = this.#get_platform(this.#get_user_agent());
    this.headers["sec-ch-ua"] = `Not)A;Brand";v="99", "${platform} WebView";v="127", "Chromium";v="127`;
    this.headers["sec-ch-ua-platform"] = platform;
    this.headers["User-Agent"] = this.#get_user_agent();
  }

  createUserAgent() {
    try {
      this.session_name = this.wallet.address;
      this.#get_user_agent();
    } catch (error) {
      this.log(`Can't create user agent: ${error.message}`, "error");
      return;
    }
  }

  async log(msg, type = "info") {
    const accountPrefix = `[Account ${this.accountIndex + 1}][${this.wallet.address}]`;
    let ipPrefix = "[Local IP]";
    if (settings.USE_PROXY) {
      ipPrefix = this.proxyIP ? `[${this.proxyIP}]` : "[Unknown IP]";
    }
    let logMessage = "";

    switch (type) {
      case "success":
        logMessage = `${accountPrefix}${ipPrefix} ${msg}`.green;
        break;
      case "error":
        logMessage = `${accountPrefix}${ipPrefix} ${msg}`.red;
        break;
      case "warning":
        logMessage = `${accountPrefix}${ipPrefix} ${msg}`.yellow;
        break;
      case "custom":
        logMessage = `${accountPrefix}${ipPrefix} ${msg}`.magenta;
        break;
      default:
        logMessage = `${accountPrefix}${ipPrefix} ${msg}`.blue;
    }
    console.log(logMessage);
  }

  async checkProxyIP() {
    try {
      const proxyAgent = new HttpsProxyAgent(this.proxy);
      const response = await axios.get("https://api.ipify.org?format=json", { httpsAgent: proxyAgent });
      if (response.status === 200) {
        this.proxyIP = response.data.ip;
        return response.data.ip;
      } else {
        throw new Error(`Cannot check proxy IP. Status code: ${response.status}`);
      }
    } catch (error) {
      throw new Error(`Error checking proxy IP: ${error.message}`);
    }
  }

  async makeRequest(
    url,
    method,
    data = {},
    options = {
      retries: 2,
      isAuth: false,
      extraHeaders: {},
      refreshToken: null,
    }
  ) {
    const { retries, isAuth, extraHeaders, refreshToken } = options;

    const headers = {
      ...this.headers,
      ...extraHeaders,
    };

    if (!isAuth && this.token) {
      headers["x-session-token"] = this.token;
    }

    let proxyAgent = null;
    if (settings.USE_PROXY) {
      proxyAgent = new HttpsProxyAgent(this.proxy);
    }
    let currRetries = 0,
      errorMessage = null,
      errorStatus = 0;

    do {
      try {
        const response = await axios({
          method,
          url,
          headers,
          timeout: 120000,
          ...(proxyAgent ? { httpsAgent: proxyAgent, httpAgent: proxyAgent } : {}),
          ...(method.toLowerCase() != "get" ? { data } : {}),
        });
        if (response?.data?.data) return { status: response.status, success: true, data: response.data.data, error: null };
        return { success: true, data: response.data, status: response.status, error: null };
      } catch (error) {
        errorStatus = error.status;
        errorMessage = error?.response?.data?.message ? error?.response?.data : error.message;
        this.log(`Request failed: ${url} | Status: ${error.status} | ${JSON.stringify(errorMessage || {})}...`, "warning");

        if (error.message.includes("stream has been aborted")) {
          return { success: false, status: error.status, data: null, error: error.response.data.error || error.response.data.message || error.message };
        }

        if (error.status == 401) {
          this.log(`Unauthorized: ${url} | trying get new token...`, "warning");
          const token = await this.getValidToken(true);
          if (!token) {
            process.exit(0);
          }
          this.token = token;
          return await this.makeRequest(url, method, data, options);
        }
        if (error.status == 400) {
          this.log(`Invalid request for ${url}, maybe have new update from server | contact: https://t.me/airdrophuntersieutoc to get new update!`, "error");
          return { success: false, status: error.status, error: errorMessage, data: null };
        }
        if (error.status == 429) {
          this.log(`Rate limit ${JSON.stringify(errorMessage)}, waiting 60s to retries`, "warning");
          await sleep(60);
        }
        if (currRetries > retries) {
          return { status: error.status, success: false, error: errorMessage, data: null };
        }
        currRetries++;
        await sleep(5);
      }
    } while (currRetries <= retries);
    return { status: errorStatus, success: false, error: errorMessage, data: null };
  }

  async auth() {
    let token = null;
    if (settings.USE_CAPTCHA) {
      this.log(`Solving captcha...`);
      token = await solveCaptcha();
      if (!token) {
        this.log("Captcha not solved, skipping...", "warning");
        await sleep(1);
        process.exit(0);
      }
    }
    const wallet = this.wallet;
    const nonce = ethers.hexlify(ethers.randomBytes(32)).slice(2);
    const timestamp = new Date().toISOString();
    const message = `klokapp.ai wants you to sign in with your Ethereum account:\n${wallet.address}\n\n\nURI: https://klokapp.ai/\nVersion: 1\nChain ID: 1\nNonce: ${nonce}\nIssued At: ${timestamp}`;
    const signedMessage = await wallet.signMessage(message);
    const payload = {
      signedMessage,
      message,
      referral_code: settings.REF_CODE,
    };
    return this.makeRequest(`${this.baseURL}/verify`, "post", payload, {
      isAuth: true,
      extraHeaders: {
        "x-turnstile-token": token,
      },
    });
  }

  async getUserData() {
    return this.makeRequest(`${this.baseURL}/me`, "get");
  }

  async getBalance() {
    return this.makeRequest(`${this.baseURL}/points`, "get");
  }

  async getModels() {
    return this.makeRequest(`${this.baseURL}/models`, "get");
  }

  async getRateLimit() {
    return this.makeRequest(`${this.baseURL}/rate-limit`, "get");
  }

  async getThreads() {
    return this.makeRequest(`${this.baseURL}/threads`, "get");
  }

  async getTask(id) {
    return this.makeRequest(`${this.baseURL}/points/action/${id}`, "get");
  }

  async completeTask(id) {
    return this.makeRequest(`${this.baseURL}/points/action/${id}`, "post");
  }

  async getRefs() {
    return this.makeRequest(`${this.baseURL}/referral/stats`, "get");
  }

  async sendMessage(payload) {
    let token = null;
    if (settings.USE_CAPTCHA) {
      this.log(`Solving captcha...`);
      token = await solveCaptcha();
      if (!token) {
        this.log("Captcha not solved, skipping...", "warning");
        await sleep(1);
        process.exit(0);
      }
    }
    return this.makeRequest(`${this.baseURL}/chat`, "post", payload, {
      extraHeaders: {
        "x-turnstile-token": token,
      },
    });
  }

  async getTitle(payload) {
    return this.makeRequest(`${this.baseURL}/chat/title`, "post", payload);
  }

  async tracking(payload) {
    return this.makeRequest(`${settings.BASE_URL_V2}`, "post", payload, {
      extraHeaders: {
        "write-key": settings.KEY_TRACKING,
      },
    });
  }

  async linkGoogle(payload) {
    return this.makeRequest(`${this.baseURL}/link-google-account`, "post", payload);
  }

  async getGoogle() {
    return this.makeRequest(`${this.baseURL}/points/action/wallet-google-link`, "get");
  }

  async handleGoogle() {
    const resGet = await this.getGoogle();
    if (!resGet.success || resGet.data?.has_completed === true) return;
    let email = this.itemData.email;

    if (!email) {
      email = generateRandomEmail();
    }
    this.log(`Linking email: ${email}...`);
    const name = email.split("@")[0];
    const payload = {
      email: email,
      name: name,
      avatar_url: "https://lh3.googleusercontent.com/a/ACg8ocKJjtdIMmOYLg8oEvX11ybNYKIxsVrr1hJKFIp4yBUqyoWgLg=s96-c",
      user_id: this.itemData.address,
    };

    const res = await this.linkGoogle(payload);
    if (res.success) {
      this.log(`Link google ${email} success!`, "success");
      await this.completeTask("wallet-google-link");
    } else {
      this.log(`Link google ${email} failed! | ${JSON.stringify(res)}`, "warning");
    }
  }

  async handleNewThread(message, model) {
    this.log(`Creating new thread | Model: ${model}`, "warning");
    const id = uuidv4();
    const payload = {
      id: id,
      title: "",
      messages: [
        {
          role: "user",
          content: message,
        },
      ],
      sources: [],
      model: model,
      created_at: new Date().toISOString(),
      language: "english",
    };
    const resultNewThread = await this.sendMessage(payload);
    const res = await this.getTitle({
      id: id,
      messages: [
        {
          role: "user",
          content: message,
        },
      ],
      language: "english",
      model: model,
    });
    if (resultNewThread.success) {
      this.log(`Create new thread ${JSON.stringify(resultNewThread.data) || {}} success!`, "success");
      return {
        ...payload,
        ...(res?.data?.title ? { title: res.data.title } : {}),
      };
    }
    return false;
  }

  async handleTracking(eventname, payload) {
    const event = events.find((i) => i.event_name == eventname);
    if (!event) return;
    const res = await this.tracking(payload);
    console.log(res);
  }

  async handleThreads(currentThread = null) {
    let model = "llama-3.3-70b-instruct";
    let amountChat = 0;
    let total = 0;

    const limitData = await this.getRateLimit();
    if (limitData.success) {
      const { current_usage, limit, remaining, reset_time } = limitData.data;
      amountChat = remaining;
      total = remaining;
      if (remaining == 0 || current_usage >= limit) {
        this.log(`Rate limit remaining: ${remaining}/${limit} | Reset time: ${Math.ceil(reset_time / 60)} minutes`, "warning");
        return;
      }
    }

    const dataModels = await this.getModels();
    if (dataModels.success && dataModels.data?.length > 0) {
      model = getRandomElement(dataModels.data).name;
    }

    //lay ds thead
    const message = getRandomElement(questions);

    if (!currentThread && !settings.AUTO_CREATE_NEW_CHAT) {
      const threads = await this.getThreads();
      if (!threads.success) {
        this.log("Can't get threads!", "warning");
      } else {
        const avaliableThreads = threads.data?.filter((t) => !t.deleted);
        currentThread = getRandomElement(avaliableThreads);
      }
    }

    if (!currentThread) {
      amountChat--;
      const res = await this.handleNewThread(message, model);
      if (res?.id) currentThread = res;
      else return this.log(`Can't starting chat...`, "warning");
    }

    this.log(`Starting chat...`, "info");
    while (amountChat > 0) {
      amountChat--;
      const newMessage = getRandomElement(questions);
      const newPayload = {
        id: currentThread.id,
        title: currentThread.title,
        messages: [
          {
            role: "user",
            content: newMessage,
          },
        ],
        sources: [],
        model: model,
        created_at: new Date().toISOString(),
        language: "english",
      };
      const result = await this.sendMessage(newPayload);
      // await this.handleTracking("message_sent", {
      //   event_name: "message_sent",
      //   properties: {
      //     thread_id: currentThread.id,
      //     thread_title: currentThread.title,
      //     thread_sources: [],
      //     input_value: message,
      //     model: model,
      //     isSearchEnabled: false,
      //   },
      //   user_id: null,
      //   anonymous_id: "xxx",
      //   timestamp: new Date().toISOString(),
      // });
      if (result.success) {
        this.log(`[${amountChat}/${total}] Send message: ${newMessage} `, "success");
      } else {
        if (JSON.stringify(result.error || {}).includes("stream has been aborted") && amountChat > 0) {
          if (threads?.data?.length && threads?.data?.length < 10) {
            const res = await this.handleNewThread(message, model);
            if (res) return await this.handleThreads(res);
            else return this.log(`Can't starting chat...`, "warning");
          } else {
            this.log(`[${amountChat}/${total}] Send message ${newMessage} failed | ${JSON.stringify(result.error || {})}`, "warning");
          }
        } else this.log(`[${amountChat}/${total}] Send message ${newMessage} failed | ${JSON.stringify(result.error || {})}`, "warning");
      }
      if (amountChat > 0) {
        const timeSleep = getRandomNumber(settings.DELAY_CHAT[0], settings.DELAY_CHAT[1]);
        this.log(`Sleeping for ${timeSleep} seconds to next message...`, "info");
        await sleep(timeSleep);
      }
    }
  }

  async handleTasks(useData) {
    const ggLinkKed = useData?.is_google_linked;
    const ids = settings.TASKS_ID;
    for (const id of ids) {
      const isCompleted = await this.getTask(id);
      if (isCompleted?.data?.has_completed === false) {
        if (!ggLinkKed && id == "wallet-google-link") continue;
        this.log(`Trying complete task ${id}`);
        const result = await this.completeTask(id);
        if (result.success) {
          this.log(`Claim task ${id} success | ${JSON.stringify(result.data || {})}`, "success");
        }
      } else if (isCompleted?.data?.has_completed === true) {
      } else {
        this.log(`Can't get task ${id} | ${JSON.stringify(isCompleted || {})}`, "warning");
      }
    }
  }

  async getValidToken(isNew = false) {
    const existingToken = this.token;
    // const isExp = isTokenExpired(existingToken);
    if (existingToken && !isNew) {
      this.log("Using valid token", "success");
      return existingToken;
    } else {
      this.log("No found token or experied, trying get new token...", "warning");
      const newToken = await this.auth();
      if (newToken.success && newToken.data?.session_token) {
        await saveJson(this.session_name, newToken.data.session_token, "localStorage.json");
        return newToken.data.session_token;
      }
      this.log("Can't get new token...", "warning");
      return null;
    }
  }

  async handleSyncData() {
    let userData = { success: false, data: null },
      retries = 0;
    do {
      userData = await this.getUserData();
      if (userData?.success) break;
      retries++;
    } while (retries < 2);
    const balanceData = await this.getBalance();
    if (userData.success && balanceData.success) {
      const { email, name } = userData.data;
      this.log(`Google Linked: ${userData.data?.is_google_linked ? email : "Not linked"} | Tier: ${userData.data.tier} | Points: ${balanceData.data.total_points}`, "custom");
    } else {
      return this.log("Can't sync new data...skipping", "warning");
    }
    return userData;
  }

  async runAccount() {
    const accountIndex = this.accountIndex;
    this.session_name = this.wallet.address;
    this.token = this.localStorage[this.session_name];
    this.#set_headers();
    if (settings.USE_PROXY) {
      try {
        this.proxyIP = await this.checkProxyIP();
      } catch (error) {
        this.log(`Cannot check proxy IP: ${this.proxy} |  ${error.message}`, "warning");
        return;
      }
      const timesleep = getRandomNumber(settings.DELAY_START_BOT[0], settings.DELAY_START_BOT[1]);
      console.log(`=========Tài khoản ${accountIndex + 1} | ${this.proxyIP} | Bắt đầu sau ${timesleep} giây...`.green);
      await sleep(timesleep);
    }

    const token = await this.getValidToken();
    if (!token) return;
    this.token = token;
    const userData = await this.handleSyncData();
    if (userData.success) {
      if (settings.AUTO_CONNECT_GOOGLE) {
        await this.handleGoogle();
      }

      if (settings.AUTO_TASK) {
        await this.handleTasks(userData.data);
      }

      await sleep(1);
      await this.handleThreads();
      await sleep(1);
      await this.handleSyncData();
    } else {
      return this.log("Can't get use info...skipping", "error");
    }
  }
}

async function runWorker(workerData) {
  const { itemData, accountIndex, proxy, hasIDAPI } = workerData;
  const to = new ClientAPI(itemData, accountIndex, proxy, hasIDAPI);
  try {
    await Promise.race([to.runAccount(), new Promise((_, reject) => setTimeout(() => reject(new Error("Timeout")), 24 * 60 * 60 * 1000))]);
    parentPort.postMessage({
      accountIndex,
    });
  } catch (error) {
    parentPort.postMessage({ accountIndex, error: error.message });
  } finally {
    if (!isMainThread) {
      parentPort.postMessage("taskComplete");
    }
  }
}

async function main() {
  console.clear();
  showBanner();
  const privateKeys = loadData("privateKeys.txt");
  const proxies = loadData("proxy.txt");
  let emails = [];
  if (settings.USE_EMAIL && settings.AUTO_CONNECT_GOOGLE) {
    emails = loadData("emails.txt");
  }
  if (privateKeys.length == 0 || (privateKeys.length > proxies.length && settings.USE_PROXY)) {
    console.log("Số lượng proxy và data phải bằng nhau.".red);
    console.log(`Data: ${privateKeys.length}`);
    console.log(`Proxy: ${proxies.length}`);
    process.exit(1);
  }
  if (!settings.USE_PROXY) {
    console.log(`You are running bot without proxies!!!`.yellow);
  }
  let maxThreads = settings.USE_PROXY ? settings.MAX_THEADS : settings.MAX_THEADS_NO_PROXY;

  const { endpoint, message } = await checkBaseUrl();
  if (!endpoint) return console.log(`Không thể tìm thấy ID API, thử lại sau!`.red);
  console.log(`${message}`.yellow);
  // process.exit();
  const data = privateKeys.map((val, index) => {
    const prvk = val.startsWith("0x") ? val : `0x${val}`;
    const wallet = new ethers.Wallet(prvk);
    const item = {
      address: wallet.address,
      privateKey: prvk,
      email: emails[index],
    };
    new ClientAPI(item, index, proxies[index], endpoint, {}).createUserAgent();
    return item;
  });

  await sleep(1);
  while (true) {
    let currentIndex = 0;
    const errors = [];
    while (currentIndex < data.length) {
      const workerPromises = [];
      const batchSize = Math.min(maxThreads, data.length - currentIndex);
      for (let i = 0; i < batchSize; i++) {
        const worker = new Worker(__filename, {
          workerData: {
            hasIDAPI: endpoint,
            itemData: data[currentIndex],
            accountIndex: currentIndex,
            proxy: proxies[currentIndex % proxies.length],
          },
        });

        workerPromises.push(
          new Promise((resolve) => {
            worker.on("message", (message) => {
              if (message === "taskComplete") {
                worker.terminate();
              }
              if (settings.ENABLE_DEBUG) {
                console.log(message);
              }
              resolve();
            });
            worker.on("error", (error) => {
              console.log(`Lỗi worker cho tài khoản ${currentIndex}: ${error.message}`);
              worker.terminate();
              resolve();
            });
            worker.on("exit", (code) => {
              worker.terminate();
              if (code !== 0) {
                errors.push(`Worker cho tài khoản ${currentIndex} thoát với mã: ${code}`);
              }
              resolve();
            });
          })
        );

        currentIndex++;
      }

      await Promise.all(workerPromises);

      if (errors.length > 0) {
        errors.length = 0;
      }

      if (currentIndex < data.length) {
        await new Promise((resolve) => setTimeout(resolve, 3000));
      }
    }

    await sleep(3);
    console.log(`=============${new Date().toLocaleString()} | Hoàn thành tất cả tài khoản | Chờ ${settings.TIME_SLEEP} phút=============`.magenta);
    showBanner();
    await sleep(settings.TIME_SLEEP * 60);
  }
}

if (isMainThread) {
  main().catch((error) => {
    console.log("Lỗi rồi:", error);
    process.exit(1);
  });
} else {
  runWorker(workerData);
}
