// =================================================================================
// モジュールのインポート
// =================================================================================
const fs = require("node:fs");
const path = require("node:path");
const { Client, GatewayIntentBits, Collection, Events } = require("discord.js");
const dotenv = require("dotenv");
const express = require("express");
const admin = require("firebase-admin");
const ejs = require("ejs");
const { v4: uuidv4 } = require("uuid");
const cron = require("node-cron");
const { google } = require("googleapis");
const { JWT } = require("google-auth-library");

dotenv.config();

// =================================================================================
// Firebase Admin SDKの初期化
// =================================================================================
try {
  const serviceAccountString = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  if (!serviceAccountString)
    throw new Error(
      "環境変数 `FIREBASE_SERVICE_ACCOUNT_JSON` が設定されていません。"
    );
  const serviceAccount = JSON.parse(serviceAccountString);
  admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
  console.log("[情報] Firebase Admin SDKが正常に初期化されました。");
} catch (error) {
  console.error(
    "[致命的エラー] Firebase Admin SDKの初期化に失敗しました:",
    error.message
  );
  process.exit(1);
}
const db = admin.firestore();

// =================================================================================
// Discordクライアントの初期化とコマンド読み込み
// =================================================================================
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});
client.commands = new Collection();
client.db = db;
const commandsPath = path.join(__dirname, "commands");
if (fs.existsSync(commandsPath)) {
  const commandFiles = fs
    .readdirSync(commandsPath)
    .filter((file) => file.endsWith(".js"));
  for (const file of commandFiles) {
    const filePath = path.join(commandsPath, file);
    const command = require(filePath);
    if ("data" in command && "execute" in command) {
      client.commands.set(command.data.name, command);
    }
  }
}

// =================================================================================
// Google Sheets API クライアント取得ヘルパー関数
// =================================================================================
async function getSheetsClient() {
  const credentialsJson = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  if (!credentialsJson)
    throw new Error(
      "GoogleサービスアカウントのJSON認証情報が.envに設定されていません。"
    );
  const serviceAccountCreds = JSON.parse(credentialsJson);
  const jwtClient = new JWT({
    email: serviceAccountCreds.client_email,
    key: serviceAccountCreds.private_key,
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  });
  return google.sheets({ version: "v4", auth: jwtClient });
}

// =================================================================================
// リマインダー スケジューラー
// =================================================================================
let dailyReminderTask = null;
async function setupReminderSchedule() {
  if (dailyReminderTask) {
    dailyReminderTask.stop();
    console.log("[リマインダー] 既存のスケジュールを停止しました。");
  }
  try {
    const settingsDoc = await db
      .collection("bot_settings")
      .doc("schedule_settings")
      .get();
    if (!settingsDoc.exists) return;
    const settings = settingsDoc.data();
    if (settings.remindersEnabled && settings.reminderTime) {
      const [hour, minute] = settings.reminderTime.split(":");
      const cronExpression = `${minute} ${hour} * * *`;
      if (cron.validate(cronExpression)) {
        const scheduleCommand = client.commands.get("schedule");
        if (
          scheduleCommand &&
          typeof scheduleCommand.scheduleDailyReminder === "function"
        ) {
          dailyReminderTask = cron.schedule(
            cronExpression,
            () => {
              scheduleCommand.scheduleDailyReminder(client, db);
            },
            { scheduled: true, timezone: "Asia/Tokyo" }
          );
          console.log(
            `[リマインダー] セットアップ完了。毎日 ${settings.reminderTime} にリマインダーが送信されます。`
          );
        }
      }
    }
  } catch (error) {
    console.error(
      "[リマインダー] スケジュールセットアップ中にエラーが発生しました:",
      error
    );
  }
}

// =================================================================================
// Expressサーバーの設定
// =================================================================================
const app = express();
const port = process.env.PORT || 80;
const adminRouter = express.Router();

// ボディパーサーミドルウェアの設定
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "views"));
adminRouter.use(express.static(path.join(__dirname, "public")));
adminRouter.use(express.json({ limit: "5mb" }));

const verifyFirebaseToken = async (req, res, next) => {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith("Bearer "))
    return res.status(401).send("Unauthorized");
  const idToken = authHeader.split("Bearer ")[1];
  try {
    const decodedToken = await admin.auth().verifyIdToken(idToken);
    const settingsDoc = await db
      .collection("bot_settings")
      .doc("toka_profile")
      .get();
    if (!settingsDoc.exists) {
      req.user = decodedToken;
      return next();
    }
    const admins = Array.isArray(settingsDoc.data().admins)
      ? settingsDoc.data().admins
      : [];
    if (
      admins.length > 0 &&
      !admins.some((admin) => admin.email === decodedToken.email)
    ) {
      return res.status(403).send("Forbidden");
    }
    req.user = decodedToken;
    next();
  } catch (error) {
    res.status(403).send("Unauthorized");
  }
};

adminRouter.get("/", (req, res) => {
  const firebaseConfig = {
    apiKey: process.env.FIREBASE_API_KEY,
    authDomain: process.env.FIREBASE_AUTH_DOMAIN,
    projectId: process.env.FIREBASE_PROJECT_ID,
    storageBucket: process.env.FIREBASE_STORAGE_BUCKET,
    messagingSenderId: process.env.FIREBASE_MESSAGING_SENDER_ID,
    appId: process.env.FIREBASE_APP_ID,
  };
  res.render("index", { firebaseConfig });
});

// --- 設定取得API ---
adminRouter.get("/api/settings/toka", verifyFirebaseToken, async (req, res) => {
  try {
    const doc = await db.collection("bot_settings").doc("toka_profile").get();
    if (!doc.exists)
      return res.status(404).json({ message: "設定がまだありません。" });

    const data = doc.data();
    const admins = data.admins || [];
    let isSuperAdmin =
      admins.length > 0 ? req.user.email === admins[0].email : true;

    res.status(200).json({
      baseUserId: data.baseUserId || null,
      systemPrompt: data.systemPrompt || "",
      enableNameRecognition: data.enableNameRecognition ?? true,
      userNicknames: data.userNicknames || {},
      modelMode: data.modelMode || "hybrid",
      enableBotMessageResponse: data.enableBotMessageResponse ?? false,
      admins: admins,
      currentUser: { isSuperAdmin: isSuperAdmin },
      replyDelayMs: data.replyDelayMs ?? 0,
      errorOopsMessage: data.errorOopsMessage || "",
    });
  } catch (error) {
    res.status(500).json({ message: "サーバーエラー" });
  }
});

adminRouter.get(
  "/api/settings/schedule",
  verifyFirebaseToken,
  async (req, res) => {
    try {
      const doc = await db
        .collection("bot_settings")
        .doc("schedule_settings")
        .get();
      if (!doc.exists)
        return res.status(404).json({ message: "設定がまだありません。" });
      res.status(200).json(doc.data());
    } catch (error) {
      res.status(500).json({ message: "サーバーエラー" });
    }
  }
);

adminRouter.get(
  "/api/schedule/items",
  verifyFirebaseToken,
  async (req, res) => {
    try {
      const settingsDoc = await db
        .collection("bot_settings")
        .doc("schedule_settings")
        .get();
      if (!settingsDoc.exists || !settingsDoc.data().googleSheetId)
        return res.status(404).json([]);
      const { googleSheetId } = settingsDoc.data();
      const sheetsClient = await getSheetsClient();
      const response = await sheetsClient.spreadsheets.values.get({
        spreadsheetId: googleSheetId,
        range: "シート1!A2:C",
      });
      res.status(200).json(response.data.values || []);
    } catch (error) {
      console.error("GET /api/schedule/items エラー:", error);
      res
        .status(500)
        .json({ message: "スプレッドシートの予定読み込みに失敗しました。" });
    }
  }
);

// --- 設定保存API ---
// 1. 設定取得API・保存APIの該当部分を修正

// 取得API
adminRouter.get("/api/settings/toka", verifyFirebaseToken, async (req, res) => {
  try {
    const doc = await db.collection("bot_settings").doc("toka_profile").get();
    if (!doc.exists)
      return res.status(404).json({ message: "設定がまだありません。" });

    const data = doc.data();
    const admins = data.admins || [];
    let isSuperAdmin =
      admins.length > 0 ? req.user.email === admins[0].email : true;

    res.status(200).json({
      baseUserId: data.baseUserId || null,
      systemPrompt: data.systemPrompt || "",
      enableNameRecognition: data.enableNameRecognition ?? true,
      userNicknames: data.userNicknames || {},
      modelMode: data.modelMode || "hybrid",
      admins: admins,
      currentUser: { isSuperAdmin: isSuperAdmin },
      enableBotMessageResponse: data.enableBotMessageResponse ?? false,
      replyDelayMs: data.replyDelayMs ?? 0,
    });
  } catch (error) {
    res.status(500).json({ message: "サーバーエラー" });
  }
});

// 保存API
adminRouter.post(
  "/api/settings/toka",
  verifyFirebaseToken,
  async (req, res) => {
    try {
      const {
        baseUserId,
        systemPrompt,
        enableNameRecognition,
        userNicknames,
        modelMode,
        enableBotMessageResponse,
        replyDelayMs,
      } = req.body;
      const dataToSave = {
        baseUserId,
        systemPrompt,
        enableNameRecognition,
        userNicknames,
        modelMode,
        enableBotMessageResponse,
        replyDelayMs: typeof replyDelayMs === "number" ? replyDelayMs : 0,
      };
      await db
        .collection("bot_settings")
        .doc("toka_profile")
        .set(dataToSave, { merge: true });
      res.status(200).json({ message: "とーか設定を更新しました。" });
    } catch (error) {
      res.status(500).json({ message: "サーバーエラー" });
    }
  }
);

adminRouter.post(
  "/api/settings/schedule",
  verifyFirebaseToken,
  async (req, res) => {
    try {
      const {
        remindersEnabled,
        reminderTime,
        googleSheetId,
        reminderRoleId,
        reminderGuildId,
      } = req.body;
      const dataToSave = {
        remindersEnabled,
        reminderTime,
        googleSheetId,
        reminderRoleId,
        reminderGuildId,
      };
      await db
        .collection("bot_settings")
        .doc("schedule_settings")
        .set(dataToSave, { merge: true });
      await setupReminderSchedule();
      res.status(200).json({ message: "スケジュール設定を更新しました。" });
    } catch (error) {
      res.status(500).json({ message: "サーバーエラー" });
    }
  }
);

adminRouter.post(
  "/api/settings/admins",
  verifyFirebaseToken,
  async (req, res) => {
    try {
      const { admins: newAdminsList } = req.body;
      const docRef = db.collection("bot_settings").doc("toka_profile");
      const docSnap = await docRef.get();
      const currentAdmins =
        docSnap.exists && Array.isArray(docSnap.data().admins)
          ? docSnap.data().admins
          : [];
      const superAdminEmail =
        currentAdmins.length > 0 ? currentAdmins[0].email : null;

      const newAdminEmails = (newAdminsList || []).map((a) => a.email);
      const currentAdminEmails = currentAdmins.map((a) => a.email);
      const adminsChanged =
        JSON.stringify([...currentAdminEmails].sort()) !==
        JSON.stringify([...newAdminEmails].sort());

      if (
        adminsChanged &&
        superAdminEmail &&
        req.user.email !== superAdminEmail
      ) {
        return res.status(403).json({
          message:
            "エラー: 管理者リストの変更は最高管理者のみ許可されています。",
        });
      }

      let finalAdmins = newAdminsList || [];
      if (!docSnap.exists || finalAdmins.length === 0) {
        finalAdmins = [
          { name: req.user.displayName || "管理者", email: req.user.email },
        ];
      }

      await docRef.set({ admins: finalAdmins }, { merge: true });
      res.status(200).json({ message: "管理者リストを更新しました。" });
    } catch (error) {
      res.status(500).json({ message: "サーバーエラー" });
    }
  }
);

adminRouter.post(
  "/api/schedule/items",
  verifyFirebaseToken,
  async (req, res) => {
    try {
      const { items } = req.body;
      if (!Array.isArray(items))
        return res.status(400).json({ message: "無効なデータ形式です。" });
      const settingsDoc = await db
        .collection("bot_settings")
        .doc("schedule_settings")
        .get();
      if (!settingsDoc.exists || !settingsDoc.data().googleSheetId)
        return res
          .status(400)
          .json({ message: "スプレッドシートが設定されていません。" });
      const { googleSheetId } = settingsDoc.data();
      const sheets = await getSheetsClient();
      const range = "シート1!A2:C";
      await sheets.spreadsheets.values.clear({
        spreadsheetId: googleSheetId,
        range,
      });
      if (items.length > 0) {
        await sheets.spreadsheets.values.update({
          spreadsheetId: googleSheetId,
          range,
          valueInputOption: "USER_ENTERED",
          resource: { values: items },
        });
      }
      res
        .status(200)
        .json({ message: "予定リストをスプレッドシートに保存しました。" });
    } catch (error) {
      res.status(500).json({ message: "予定リストの保存に失敗しました。" });
    }
  }
);

// メールアドレス更新用のエンドポイント
app.post("/api/update-email", verifyFirebaseToken, async (req, res) => {
  try {
    const { oldEmail, newEmail } = req.body;
    const userEmail = req.user.email;

    // 権限チェック
    if (userEmail !== oldEmail) {
      return res.status(403).json({
        message: "他のユーザーのメールアドレスは更新できません。",
      });
    }

    // Firestoreでのメールアドレス更新
    const settingsRef = db.collection("bot_settings").doc("toka_profile");
    const settingsDoc = await settingsRef.get();

    if (settingsDoc.exists) {
      const data = settingsDoc.data();
      const admins = Array.isArray(data.admins) ? data.admins : [];

      const updatedAdmins = admins.map((admin) => {
        if (admin.email === oldEmail) {
          return { ...admin, email: newEmail };
        }
        return admin;
      });

      await settingsRef.update({
        admins: updatedAdmins,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });
    }

    res.json({
      message: "メールアドレスを更新しました。",
      email: newEmail,
    });
  } catch (error) {
    console.error("メールアドレス更新エラー:", error);
    res.status(500).json({
      message: "メールアドレスの更新中にエラーが発生しました。",
      details: error.message,
    });
  }
});

// 公開APIエンドポイント
app.get("/api/schedule/public", async (req, res) => {
  try {
    const settingsDoc = await db
      .collection("bot_settings")
      .doc("schedule_settings")
      .get();

    if (!settingsDoc.exists || !settingsDoc.data().googleSheetId) {
      return res.status(404).json({
        items: [],
        settings: {},
      });
    }

    const settings = settingsDoc.data();
    const sheets = await getSheetsClient();
    const response = await sheets.spreadsheets.values.get({
      spreadsheetId: settings.googleSheetId,
      range: "シート1!A2:C",
    });

    res.status(200).json({
      items: response.data.values || [],
      settings: {
        googleSheetId: settings.googleSheetId,
        remindersEnabled: settings.remindersEnabled,
        reminderTime: settings.reminderTime,
        reminderGuildId: settings.reminderGuildId,
        reminderRoleId: settings.reminderRoleId,
      },
    });
  } catch (error) {
    console.error("GET /api/schedule/public エラー:", error);
    res.status(500).json({
      message: "スケジュール情報の取得に失敗しました。",
      error: error.message,
    });
  }
});

app.post("/api/schedule/public/add", async (req, res) => {
  try {
    const { items } = req.body;
    if (!Array.isArray(items)) {
      return res.status(400).json({ message: "無効なデータ形式です。" });
    }

    const settingsDoc = await db
      .collection("bot_settings")
      .doc("schedule_settings")
      .get();

    if (!settingsDoc.exists || !settingsDoc.data().googleSheetId) {
      return res
        .status(404)
        .json({ message: "スケジュール設定が見つかりません。" });
    }

    const { googleSheetId } = settingsDoc.data();
    const sheets = await getSheetsClient();

    await sheets.spreadsheets.values.append({
      spreadsheetId: googleSheetId,
      range: "シート1",
      valueInputOption: "USER_ENTERED",
      resource: { values: items },
    });

    res.status(200).json({
      message: "予定を追加しました。",
      count: items.length,
    });
  } catch (error) {
    console.error("POST /api/schedule/public/add エラー:", error);
    res.status(500).json({ message: "予定の追加に失敗しました。" });
  }
});

app.post("/api/schedule/public/update", async (req, res) => {
  try {
    const { index, item } = req.body;
    if (!Array.isArray(item) || typeof index !== "number") {
      return res.status(400).json({ message: "無効なデータ形式です。" });
    }

    const settingsDoc = await db
      .collection("bot_settings")
      .doc("schedule_settings")
      .get();

    if (!settingsDoc.exists || !settingsDoc.data().googleSheetId) {
      return res
        .status(404)
        .json({ message: "スケジュール設定が見つかりません。" });
    }

    const { googleSheetId } = settingsDoc.data();
    const sheets = await getSheetsClient();

    await sheets.spreadsheets.values.update({
      spreadsheetId: googleSheetId,
      range: `シート1!A${index + 2}:C${index + 2}`,
      valueInputOption: "USER_ENTERED",
      resource: { values: [item] },
    });

    res.status(200).json({ message: "予定を更新しました。" });
  } catch (error) {
    console.error("POST /api/schedule/public/update エラー:", error);
    res.status(500).json({ message: "予定の更新に失敗しました。" });
  }
});

app.post("/api/schedule/public/delete", async (req, res) => {
  try {
    const { indices } = req.body;
    if (!Array.isArray(indices)) {
      return res.status(400).json({ message: "無効なデータ形式です。" });
    }

    const settingsDoc = await db
      .collection("bot_settings")
      .doc("schedule_settings")
      .get();

    if (!settingsDoc.exists || !settingsDoc.data().googleSheetId) {
      return res
        .status(404)
        .json({ message: "スケジュール設定が見つかりません。" });
    }

    const { googleSheetId } = settingsDoc.data();
    const sheets = await getSheetsClient();

    // スプレッドシート情報の取得
    const spreadsheetInfo = await sheets.spreadsheets.get({
      spreadsheetId: googleSheetId,
    });

    const sheet1 = spreadsheetInfo.data.sheets.find(
      (s) => s.properties.title === "シート1"
    );

    if (!sheet1) {
      throw new Error("シート1が見つかりません。");
    }

    const deleteRequests = indices
      .filter((idx) => typeof idx === "number" && idx >= 0)
      .sort((a, b) => b - a)
      .map((index) => ({
        deleteDimension: {
          range: {
            sheetId: sheet1.properties.sheetId,
            dimension: "ROWS",
            startIndex: index + 1,
            endIndex: index + 2,
          },
        },
      }));

    if (deleteRequests.length > 0) {
      await sheets.spreadsheets.batchUpdate({
        spreadsheetId: googleSheetId,
        resource: { requests: deleteRequests },
      });
    }

    res.status(200).json({
      message: "予定を削除しました。",
      count: deleteRequests.length,
    });
  } catch (error) {
    console.error("POST /api/schedule/public/delete エラー:", error);
    res.status(500).json({ message: "予定の削除に失敗しました。" });
  }
});

// プロファイル更新API
app.post("/api/update-profile", verifyFirebaseToken, async (req, res) => {
  try {
    const { displayName } = req.body;
    const userEmail = req.user.email;

    console.log("プロファイル更新リクエスト:", {
      userEmail,
      displayName,
      timestamp: new Date().toISOString(),
    });

    // 入力値の検証
    if (!displayName || typeof displayName !== "string") {
      return res.status(400).json({
        message: "表示名が正しく指定されていません。",
      });
    }

    // bot_settingsコレクションのtoka_profileドキュメントを取得
    const settingsRef = db.collection("bot_settings").doc("toka_profile");
    const settingsDoc = await settingsRef.get();

    console.log("設定ドキュメントの存在:", settingsDoc.exists);

    let admins = [];
    if (settingsDoc.exists) {
      const data = settingsDoc.data();
      admins = Array.isArray(data.admins) ? data.admins : [];
    }

    console.log("現在の管理者リスト:", admins);

    // 管理者リストの更新
    let updatedAdmins;
    const adminIndex = admins.findIndex((admin) => admin.email === userEmail);

    if (adminIndex === -1) {
      // 新規ユーザーの場合は追加
      updatedAdmins = [
        ...admins,
        {
          email: userEmail,
          name: displayName,
          updatedAt: new Date().toISOString(),
        },
      ];
    } else {
      // 既存ユーザーの場合は更新
      updatedAdmins = admins.map((admin, index) => {
        if (index === adminIndex) {
          return {
            ...admin,
            name: displayName,
            updatedAt: new Date().toISOString(),
          };
        }
        return admin;
      });
    }

    console.log("更新する管理者リスト:", updatedAdmins);

    // Firestoreの更新
    await settingsRef.set(
      {
        admins: updatedAdmins,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      },
      { merge: true }
    );

    console.log("データベース更新完了");

    // 成功レスポンス
    res.json({
      message: "プロファイルを更新しました。",
      displayName,
      email: userEmail,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    // エラーの詳細をログに記録
    console.error("プロファイル更新エラー:", {
      message: error.message,
      stack: error.stack,
      userEmail: req.user?.email,
      timestamp: new Date().toISOString(),
    });

    // クライアントへのエラーレスポンス
    res.status(500).json({
      message: "プロファイルの更新中にエラーが発生しました。",
      details: error.message,
      timestamp: new Date().toISOString(),
    });
  }
});

// --- 招待コード・登録API ---
adminRouter.post(
  "/api/generate-invite-code",
  verifyFirebaseToken,
  async (req, res) => {
    try {
      const settingsDoc = await db
        .collection("bot_settings")
        .doc("toka_profile")
        .get();
      const admins =
        settingsDoc.exists && Array.isArray(settingsDoc.data().admins)
          ? settingsDoc.data().admins
          : [];
      const superAdminEmail = admins.length > 0 ? admins[0].email : null;
      if (!superAdminEmail || req.user.email !== superAdminEmail)
        return res.status(403).json({
          message: "招待コードの発行は最高管理者のみ許可されています。",
        });
      const newCode = uuidv4().split("-")[0].toUpperCase();
      await db.collection("invitation_codes").doc(newCode).set({
        code: newCode,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
        createdBy: req.user.email,
        used: false,
        usedBy: null,
        usedAt: null,
      });
      res.status(201).json({ code: newCode });
    } catch (error) {
      res.status(500).json({ message: "招待コードの生成に失敗しました。" });
    }
  }
);

adminRouter.post("/api/register-with-invite", async (req, res) => {
  try {
    const { inviteCode, displayName, email, password } = req.body;
    if (!inviteCode || !displayName || !email || !password)
      return res
        .status(400)
        .json({ message: "すべての項目を入力してください。" });
    const inviteCodeRef = db.collection("invitation_codes").doc(inviteCode);
    const codeDoc = await inviteCodeRef.get();
    if (!codeDoc.exists || codeDoc.data().used)
      return res
        .status(400)
        .json({ message: "この招待コードは無効か、既に使用されています。" });
    const userRecord = await admin
      .auth()
      .createUser({ email, password, displayName });
    const settingsRef = db.collection("bot_settings").doc("toka_profile");
    await db.runTransaction(async (transaction) => {
      const settingsDoc = await transaction.get(settingsRef);
      const admins =
        settingsDoc.exists && Array.isArray(settingsDoc.data().admins)
          ? settingsDoc.data().admins
          : [];
      admins.push({ name: displayName, email: email });
      transaction.set(settingsRef, { admins }, { merge: true });
    });
    await inviteCodeRef.update({
      used: true,
      usedBy: email,
      usedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
    res.status(201).json({
      message: `ようこそ、${displayName}さん！アカウントが正常に作成されました。ログインしてください。`,
    });
  } catch (error) {
    if (error.code === "auth/email-already-exists")
      return res
        .status(400)
        .json({ message: "このメールアドレスは既に使用されています。" });
    res.status(500).json({ message: "アカウントの作成に失敗しました。" });
  }
});

app.use((req, res, next) => {
  if (req.hostname === process.env.ADMIN_DOMAIN) {
    adminRouter(req, res, next);
  } else {
    next();
  }
});
app.listen(port, () => {
  console.log(`[情報] Webサーバーがポート ${port} で起動しました。`);
});

client.once(Events.ClientReady, (c) => {
  console.log(`✅ ボット起動: ${c.user.tag}`);
  c.application.commands.set(client.commands.map((cmd) => cmd.data.toJSON()));
  setupReminderSchedule();
  client.user.setActivity("Pornhub", { type: 3 }); // type: 3 = Watching
});
client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isChatInputCommand()) return;
  const command = client.commands.get(interaction.commandName);
  if (!command) return;
  try {
    await command.execute(interaction);
  } catch (error) {
    console.error(`コマンドエラー (${interaction.commandName}):`, error);
  }
});
client.login(process.env.DISCORD_TOKEN);