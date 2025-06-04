// discord.js から必要なビルダーとスタイルをインポート
const {
  SlashCommandBuilder,
  EmbedBuilder,
  MessageFlags,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle
} = require('discord.js');
const { google } = require('googleapis');
const { JWT } = require('google-auth-library');
const { GoogleGenerativeAI } = require('@google/generative-ai');
require('dotenv').config();

// スプレッドシートIDと範囲
const sheetId = process.env.GOOGLE_SHEET_ID || '16Mf4f4lIyqvzxjx5Nj8zgvXXRyIZjGFtfQlNmjjzKig';
const listRange = 'シート1!A2:C';
const appendRange = 'シート1!A:A';

// Google Sheets API クライアントを取得するヘルパー関数
async function getSheetsClient() {
  if (!process.env.GOOGLE_SERVICE_ACCOUNT_CREDENTIALS_JSON) {
    throw new Error('GOOGLE_SERVICE_ACCOUNT_CREDENTIALS_JSON environmental variable is not set.');
  }
  const serviceAccountCreds = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_CREDENTIALS_JSON);
  const jwtClient = new JWT({
    email: serviceAccountCreds.client_email,
    key: serviceAccountCreds.private_key,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
  return google.sheets({ version: 'v4', auth: jwtClient });
}

// Gemini API クライアントの初期化
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

/**
 * ユーザー入力から予定情報を抽出するAI関数
 */
async function extractScheduleInfoWithAI(userInput) {
  const tryModels = ['gemini-1.5-flash', 'gemini-1.5-pro'];
  let lastError = null;

  const prompt = `
以下のユーザー入力を分析し、予定の「種別」「内容」「期限」を抽出してください。
種別の記述がない場合は「課題」「テスト」「その他」の中から考えて選んでください。
漢数字はすべて半角算用数字に書き換えること。内容が冗長にならないように気をつけること。
「明日」「明後日」は今日 (${new Date().toLocaleDateString('ja-JP', { year: 'numeric', month: '2-digit', day: '2-digit'})}) からの日付で期限を考えること。
結果は必ず以下のJSON形式の文字列で出力してください。他の説明や前置きは一切不要です。

{
  "type": "抽出した種別",
  "task": "抽出した具体的な内容",
  "due": "抽出した期限 (可能な限りYYYY-MM-DD形式、またはMM/DD形式、または具体的な日付表現。不明な場合は「不明」)"
}

ユーザー入力: "${userInput}"
`;

  for (const modelName of tryModels) {
    try {
      const model = genAI.getGenerativeModel({ model: modelName });
      const result = await model.generateContent(prompt);
      const response = await result.response;
      const rawResponseText = response.text().trim();
      let jsonToParse = rawResponseText;

      if (jsonToParse.startsWith("```json")) {
        jsonToParse = jsonToParse.substring(7);
        if (jsonToParse.endsWith("```")) {
          jsonToParse = jsonToParse.substring(0, jsonToParse.length - 3);
        }
      } else if (jsonToParse.startsWith("```")) {
        jsonToParse = jsonToParse.substring(3);
        if (jsonToParse.endsWith("```")) {
          jsonToParse = jsonToParse.substring(0, jsonToParse.length - 3);
        }
      }
      jsonToParse = jsonToParse.trim();

      if (jsonToParse.startsWith('{') && jsonToParse.endsWith('}')) {
        try {
          return JSON.parse(jsonToParse);
        } catch (parseError) {
          console.warn(`[${modelName} - ScheduleAI] JSONのパースに失敗 (Markdown除去後): ${parseError.message}. 元の応答: ${rawResponseText}`);
          lastError = parseError;
          continue;
        }
      } else {
        console.warn(`[${modelName} - ScheduleAI] AIの応答がJSON形式ではありません (Markdown除去後): ${jsonToParse}. 元の応答: ${rawResponseText}`);
        lastError = new Error(`AI response was not valid JSON after stripping Markdown. Content: ${jsonToParse}`);
        continue;
      }
    } catch (error) {
      console.warn(`[${modelName} - ScheduleAI] での情報抽出に失敗: ${error.message}`);
      lastError = error;
      if (error.message.includes('429') || error.message.includes('Quota') || error.message.includes('API key not valid')) {
        console.error(`[${modelName} - ScheduleAI] APIエラー。処理を中断します。: ${error.message}`);
        break;
      }
    }
  }
  console.error("全てのAIモデルでの情報抽出に失敗しました (ScheduleAI)。", lastError ? lastError.message : "不明なエラー");
  return null;
}

/**
 * ユーザー入力と予定リストから削除対象を特定するAI関数
 */
async function extractDeletionTargetWithAI(userInput, currentSchedules) {
  const tryModels = ['gemini-1.5-flash', 'gemini-1.5-pro'];
  let lastError = null;

  const formattedSchedules = currentSchedules.map((item, index) => ({
    index, 
    type: item[0] || 'N/A',
    task: item[1] || 'N/A',
    due: item[2] || 'N/A',
  }));

  const prompt = `
以下の予定リストの中から、ユーザーが削除したいと述べている予定を特定し、その予定のリスト内での【0始まりのインデックス番号】と【タスク内容】を抽出してください。
ユーザー入力の日付表現（「明日」「昨日」など）は、今日が ${new Date().toLocaleDateString('ja-JP', { year: 'numeric', month: '2-digit', day: '2-digit'})} であることを考慮して解釈してください。
もし完全に一致するものが複数ある場合や、曖昧で特定が困難な場合は、"indexToDelete" を null とし、"reason" にその理由を日本語で記述してください。
特定できた場合は、"reason" は不要です。
結果は必ず以下のJSON形式の文字列で出力してください。他の説明や前置きは一切不要です。

予定リスト:
${JSON.stringify(formattedSchedules)}

ユーザーの削除リクエスト: "${userInput}"

JSON形式:
{
  "indexToDelete": extracted_index_or_null,
  "identifiedTask": "extracted_task_content_if_found",
  "reason": "reason_if_ambiguous_or_not_found_in_Japanese"
}
`;

  for (const modelName of tryModels) {
    try {
      const model = genAI.getGenerativeModel({ model: modelName });
      const result = await model.generateContent(prompt);
      const response = await result.response;
      const rawResponseText = response.text().trim();
      let jsonToParse = rawResponseText;

      if (jsonToParse.startsWith("```json")) {
        jsonToParse = jsonToParse.substring(7);
        if (jsonToParse.endsWith("```")) {
          jsonToParse = jsonToParse.substring(0, jsonToParse.length - 3);
        }
      } else if (jsonToParse.startsWith("```")) {
        jsonToParse = jsonToParse.substring(3);
        if (jsonToParse.endsWith("```")) {
          jsonToParse = jsonToParse.substring(0, jsonToParse.length - 3);
        }
      }
      jsonToParse = jsonToParse.trim();
      
      if (jsonToParse.startsWith('{') && jsonToParse.endsWith('}')) {
        try {
          return JSON.parse(jsonToParse);
        } catch (parseError) {
          console.warn(`[${modelName} - DeletionAI] JSONのパースに失敗 (Markdown除去後): ${parseError.message}. 元の応答: ${rawResponseText}`);
          lastError = parseError;
          continue;
        }
      } else {
        console.warn(`[${modelName} - DeletionAI] AIの応答がJSON形式ではありません (Markdown除去後): ${jsonToParse}. 元の応答: ${rawResponseText}`);
        lastError = new Error(`AI response was not valid JSON after stripping Markdown. Content: ${jsonToParse}`);
        continue;
      }
    } catch (error) {
      console.warn(`[${modelName} - DeletionAI] での情報抽出に失敗: ${error.message}`);
      lastError = error;
      if (error.message.includes('429') || error.message.includes('Quota') || error.message.includes('API key not valid')) {
        console.error(`[${modelName} - DeletionAI] APIエラー。処理を中断します。: ${error.message}`);
        break;
      }
    }
  }
  console.error("全てのAIモデルでの削除対象特定に失敗しました (DeletionAI)。", lastError ? lastError.message : "不明なエラー");
  return { indexToDelete: null, reason: "AIモデルでの処理中にエラーが発生しました。" };
}

/**
 * 1件の予定情報を Embed に整形する関数
 */
function createScheduleEmbed(scheduleItem, currentIndex, totalSchedules) {
  const type = scheduleItem[0] || 'N/A';
  const task = scheduleItem[1] || 'N/A';
  const dueDate = scheduleItem[2] || 'N/A';

  return new EmbedBuilder()
    .setTitle(`📝 ${type} (${currentIndex + 1}/${totalSchedules})`)
    .setColor(0x0099FF)
    .addFields(
      { name: '内容', value: task, inline: false },
      { name: '期限', value: dueDate, inline: false }
    )
    .setTimestamp()
    .setFooter({ text: `予定 ${currentIndex + 1} / ${totalSchedules}` });
}

/**
 * ナビゲーション、追加、編集、削除ボタンを作成・更新する関数 (更新)
 */
function updateScheduleButtons(currentIndex, totalSchedules, schedulesExist) {
  const row = new ActionRowBuilder()
    .addComponents(
      new ButtonBuilder()
        .setCustomId('schedule_previous')
        .setLabel('前の予定')
        .setStyle(ButtonStyle.Primary)
        .setDisabled(currentIndex === 0 || !schedulesExist),
      new ButtonBuilder()
        .setCustomId('schedule_next')
        .setLabel('次の予定')
        .setStyle(ButtonStyle.Primary)
        .setDisabled(currentIndex >= totalSchedules - 1 || !schedulesExist),
      new ButtonBuilder()
        .setCustomId('schedule_add_modal_trigger')
        .setLabel('追加')
        .setStyle(ButtonStyle.Success)
    );

  if (schedulesExist) {
    row.addComponents(
      new ButtonBuilder() // ★編集ボタン追加
        .setCustomId('schedule_edit_modal_trigger')
        .setLabel('編集')
        .setStyle(ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId('schedule_delete_modal_trigger')
        .setLabel('削除')
        .setStyle(ButtonStyle.Danger)
    );
  }
  return row;
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('schedule')
    .setDescription('登録されている予定をボタンで確認・追加・編集・削除します。'), // 説明を更新

  async execute(interaction) {
    if (!interaction.inGuild()) {
      await interaction.reply({ content: 'このコマンドはサーバー内でのみ使用できます。', ephemeral: true });
      return;
    }

    await interaction.deferReply();
    let sheets;

    try {
      sheets = await getSheetsClient();
    } catch (authError) {
      console.error('Google API Authentication Error (Schedule View):', authError);
      await interaction.editReply({ content: '❌ Google APIへの認証に失敗しました。設定を確認してください。' });
      return;
    }

    let schedules = [];
    try {
      const response = await sheets.spreadsheets.values.get({
        spreadsheetId: sheetId,
        range: listRange,
      });
      schedules = response.data.values || [];
    } catch (error) {
      console.error('Error fetching schedules from Google Sheets:', error);
      await interaction.editReply({ content: '❌ スプレッドシートからの予定の読み込みに失敗しました。' });
      return;
    }

    let currentIndex = 0;
    const totalSchedules = schedules.length;
    const schedulesExist = totalSchedules > 0;

    if (!schedulesExist) {
      const row = updateScheduleButtons(0, 0, false);
      await interaction.editReply({ content: 'ℹ️ 登録されている予定はありません。「追加」ボタンから新しい予定を登録できます。', components: [row] });
    }

    const initialEmbed = schedulesExist ? createScheduleEmbed(schedules[currentIndex], currentIndex, totalSchedules) : null;
    const initialRow = updateScheduleButtons(currentIndex, totalSchedules, schedulesExist); 

    const replyOptions = { components: [initialRow] };
    if (initialEmbed) {
      replyOptions.embeds = [initialEmbed];
    } else if (!schedulesExist) { 
      replyOptions.content = 'ℹ️ 登録されている予定はありません。「追加」ボタンから新しい予定を登録できます。';
    }

    const message = await interaction.editReply(replyOptions);

    const filter = (i) => {
      if (!i.isButton()) return false;
      if (i.user.id !== interaction.user.id) {
        i.reply({ content: 'このボタンはコマンドの実行者のみ操作できます。', ephemeral: true });
        return false;
      }
      return ['schedule_previous', 'schedule_next', 'schedule_add_modal_trigger', 'schedule_edit_modal_trigger', 'schedule_delete_modal_trigger'].includes(i.customId);
    };

    const collector = message.createMessageComponentCollector({ filter, time: 300000 }); 

    collector.on('collect', async (i) => {
      try {
        if (i.customId === 'schedule_previous') {
          if (!schedulesExist) { await i.deferUpdate(); return; }
          currentIndex--;
          const newEmbed = createScheduleEmbed(schedules[currentIndex], currentIndex, totalSchedules);
          const newRow = updateScheduleButtons(currentIndex, totalSchedules, schedulesExist);
          await i.update({ embeds: [newEmbed], components: [newRow] });
        } else if (i.customId === 'schedule_next') {
          if (!schedulesExist) { await i.deferUpdate(); return; }
          currentIndex++;
          const newEmbed = createScheduleEmbed(schedules[currentIndex], currentIndex, totalSchedules);
          const newRow = updateScheduleButtons(currentIndex, totalSchedules, schedulesExist);
          await i.update({ embeds: [newEmbed], components: [newRow] });
        } else if (i.customId === 'schedule_add_modal_trigger') {
          // ... (既存の追加モーダル表示処理) ...
          const modal = new ModalBuilder()
            .setCustomId('schedule_add_text_modal')
            .setTitle('新しい予定を文章で追加');
          const scheduleInput = new TextInputBuilder()
            .setCustomId('schedule_text_input')
            .setLabel('予定の詳細を文章で入力してください')
            .setStyle(TextInputStyle.Paragraph)
            .setPlaceholder('例: 明日の数学の宿題 P10-15 提出は土曜日')
            .setRequired(true);
          const actionRowModal = new ActionRowBuilder().addComponents(scheduleInput);
          modal.addComponents(actionRowModal);
          await i.showModal(modal);
        } else if (i.customId === 'schedule_edit_modal_trigger') { // ★編集ボタンの処理
          if (!schedulesExist || !schedules[currentIndex]) {
            await i.reply({ content: '編集対象の予定がありません。', ephemeral: true });
            return;
          }
          const currentSchedule = schedules[currentIndex];
          const type = currentSchedule[0] || '';
          const task = currentSchedule[1] || '';
          const due = currentSchedule[2] || '';

          const editModal = new ModalBuilder()
            .setCustomId(`schedule_edit_modal_submit_${currentIndex}`) // customId に現在のインデックスを含める
            .setTitle('予定を編集');

          const typeInput = new TextInputBuilder()
            .setCustomId('edit_type_input')
            .setLabel('種別')
            .setStyle(TextInputStyle.Short)
            .setValue(type)
            .setPlaceholder('例: 課題, テスト, その他')
            .setRequired(false);

          const taskInput = new TextInputBuilder()
            .setCustomId('edit_task_input')
            .setLabel('内容')
            .setStyle(TextInputStyle.Paragraph)
            .setValue(task)
            .setPlaceholder('例: 数学の宿題 P10-15')
            .setRequired(true);

          const dueInput = new TextInputBuilder()
            .setCustomId('edit_due_input')
            .setLabel('期限')
            .setStyle(TextInputStyle.Short)
            .setValue(due)
            .setPlaceholder('例: 明日, YYYY-MM-DD, MM/DD')
            .setRequired(false);

          editModal.addComponents(
            new ActionRowBuilder().addComponents(typeInput),
            new ActionRowBuilder().addComponents(taskInput),
            new ActionRowBuilder().addComponents(dueInput)
          );
          await i.showModal(editModal);
        } else if (i.customId === 'schedule_delete_modal_trigger') {
          // ... (既存の削除モーダル表示処理) ...
          const deleteModal = new ModalBuilder()
            .setCustomId('schedule_delete_text_modal') 
            .setTitle('削除する予定の情報を入力');
          const deleteInput = new TextInputBuilder()
            .setCustomId('schedule_delete_description_input') 
            .setLabel('削除したい予定の特徴を教えてください')
            .setStyle(TextInputStyle.Short)
            .setPlaceholder('例: 明日の数学の宿題、会議の資料など')
            .setRequired(true);
          const actionRowModalDelete = new ActionRowBuilder().addComponents(deleteInput);
          deleteModal.addComponents(actionRowModalDelete);
          await i.showModal(deleteModal);
        }
      } catch (error) {
        console.error('Error during button interaction:', error);
        // エラーが reply/deferUpdate 前か後かで分岐
        if (!i.replied && !i.deferred && i.isRepliable()) { // isRepliable() で確認
            await i.reply({ content: '⚠️ ボタンの処理中にエラーが発生しました。', ephemeral: true }).catch(console.error);
        } else if (i.isRepliable()){ // deferUpdate 済みの場合など
            await i.followUp({ content: '⚠️ ボタンの処理中にエラーが発生しました。', ephemeral: true }).catch(console.error);
        } else {
            console.error("Interaction is not repliable.");
        }
      }
    });

    collector.on('end', (collected, reason) => {
      const finalRow = updateScheduleButtons(currentIndex, totalSchedules, schedulesExist); 
      const disabledRow = new ActionRowBuilder();
      finalRow.components.forEach(button => {
        disabledRow.addComponents(ButtonBuilder.from(button).setDisabled(true));
      });
        
      if (message && message.editable) {
         message.edit({ components: [disabledRow] }).catch(console.error);
      }
    });
  },

  /**
   * 追加用モーダル処理
   */
  async handleScheduleModalSubmit(modalInteraction) {
    // ... (変更なし) ...
    await modalInteraction.deferReply({ ephemeral: true });

    const userInput = modalInteraction.fields.getTextInputValue('schedule_text_input');
    const scheduleData = await extractScheduleInfoWithAI(userInput);

    if (scheduleData && scheduleData.task) {
      const { type = '未分類', task, due = '不明' } = scheduleData;
      let sheets;
      try {
        sheets = await getSheetsClient();
      } catch (authError) {
        console.error('Google API Authentication Error (Modal Add):', authError);
        await modalInteraction.editReply({ content: '❌ Google API認証に失敗しました。予定を登録できません。' });
        return;
      }

      try {
        await sheets.spreadsheets.values.append({
          spreadsheetId: sheetId,
          range: appendRange,
          valueInputOption: 'USER_ENTERED',
          resource: {
            values: [[type, task, due]],
          },
        });
        await modalInteraction.editReply({ content: `✅ 予定をスプレッドシートに追加しました！\n種別: ${type}\n内容: ${task}\n期限: ${due}\nリストを更新するには、再度 \`/schedule\` コマンドを実行してください。` });
      } catch (sheetError) {
        console.error('Google Sheets API (append) error:', sheetError);
        await modalInteraction.editReply({ content: '❌ スプレッドシートへの予定追加中にエラーが発生しました。' });
      }
    } else {
      await modalInteraction.editReply({ content: '❌ AIが予定情報をうまく抽出できませんでした。もう少し具体的に入力してみてください。\n例: 「種別は宿題、内容は国語の教科書P20、期限は来週の月曜日」' });
    }
  },

  /**
   * 削除用モーダル処理
   */
  async handleScheduleDeleteModal(modalInteraction) {
    // ... (変更なし) ...
    await modalInteraction.deferReply({ ephemeral: true });

    const userInput = modalInteraction.fields.getTextInputValue('schedule_delete_description_input');
    let sheets;
    let currentSchedules = [];

    try {
      sheets = await getSheetsClient();
      const response = await sheets.spreadsheets.values.get({
        spreadsheetId: sheetId,
        range: listRange,
      });
      currentSchedules = response.data.values || [];
      if (currentSchedules.length === 0) {
        await modalInteraction.editReply({ content: 'ℹ️ 現在登録されている予定はありません。削除する対象がありません。' });
        return;
      }
    } catch (error) {
      console.error('Error fetching schedules for deletion:', error);
      await modalInteraction.editReply({ content: '❌ スプレッドシートからの予定の読み込みに失敗しました。' });
      return;
    }

    const deletionTarget = await extractDeletionTargetWithAI(userInput, currentSchedules);

    if (deletionTarget && typeof deletionTarget.indexToDelete === 'number') {
      const targetIndex = deletionTarget.indexToDelete;
      if (targetIndex < 0 || targetIndex >= currentSchedules.length) {
        await modalInteraction.editReply({ content: `❌ AIが示したインデックス (${targetIndex}) が範囲外です。既存の予定数: ${currentSchedules.length}` });
        return;
      }
      const scheduleToDelete = currentSchedules[targetIndex];
      const type = scheduleToDelete[0] || 'N/A';
      const task = scheduleToDelete[1] || 'N/A';
      const due = scheduleToDelete[2] || 'N/A';

      try {
        let targetSheetGid = 0; 
        try {
          const spreadsheetInfo = await sheets.spreadsheets.get({ spreadsheetId: sheetId });
          const sheet1 = spreadsheetInfo.data.sheets.find(s => s.properties.title === 'シート1');
          if (sheet1) {
            targetSheetGid = sheet1.properties.sheetId;
          } else {
            console.warn("シート 'シート1' が見つかりませんでした。gid=0 を使用します。");
          }
        } catch (e) {
          console.warn(`シートのgid取得に失敗: ${e.message}. デフォルトのgid=0 を使用します。`);
        }
        
        const sheetRowStartIndex = targetIndex + 1;

        await sheets.spreadsheets.batchUpdate({
          spreadsheetId: sheetId,
          resource: {
            requests: [
              {
                deleteDimension: {
                  range: {
                    sheetId: targetSheetGid,
                    dimension: 'ROWS',
                    startIndex: sheetRowStartIndex,
                    endIndex: sheetRowStartIndex + 1,
                  },
                },
              },
            ],
          },
        });
        await modalInteraction.editReply({ content: `✅ 予定「${task}」(種別: ${type}, 期限: ${due}) をスプレッドシートから削除しました。\nリストを更新するには、再度 \`/schedule\` コマンドを実行してください。` });
      } catch (sheetError) {
        console.error('Google Sheets API (delete) error:', sheetError.message, sheetError.errors);
        await modalInteraction.editReply({ content: '❌ スプレッドシートからの予定削除中にエラーが発生しました。' });
      }
    } else {
      const reason = deletionTarget.reason || "AIが予定を特定できませんでした。";
      await modalInteraction.editReply({ content: `❌ 削除対象の予定を特定できませんでした。\n理由: ${reason}\nもう少し具体的に入力するか、内容が正しいか確認してください。` });
    }
  },

  /**
   * ★編集用モーダルから送信されたデータを処理し、スプレッドシートを更新する関数 (新規追加)★
   * @param {import('discord.js').ModalSubmitInteraction} modalInteraction
   * @param {number} targetIndex 編集対象の予定の0ベースインデックス
   */
  async handleScheduleEditModal(modalInteraction, targetIndex) {
    await modalInteraction.deferReply({ ephemeral: true });

    const newType = modalInteraction.fields.getTextInputValue('edit_type_input').trim() || 'その他';
    const newTask = modalInteraction.fields.getTextInputValue('edit_task_input').trim();
    const newDueRaw = modalInteraction.fields.getTextInputValue('edit_due_input').trim() || '不明';

    if (!newTask) {
        await modalInteraction.editReply({ content: '❌ 内容は必須です。' });
        return;
    }

    let newDue = newDueRaw;
    // 期限が入力されており、かつ「不明」でない場合、AIで日付形式に変換を試みる
    if (newDueRaw && newDueRaw.toLowerCase() !== '不明' && newDueRaw.toLowerCase() !== 'na' && newDueRaw.toLowerCase() !== 'n/a') {
        const scheduleLikeString = `${newType} ${newTask} ${newDueRaw}`; // AIが解釈しやすいように文字列を構成
        const extractedDateInfo = await extractScheduleInfoWithAI(scheduleLikeString); // 既存のAI関数を利用
        if (extractedDateInfo && extractedDateInfo.due && extractedDateInfo.due !== '不明') {
            newDue = extractedDateInfo.due;
        } else {
            // AIが日付を抽出できなかった場合、ユーザーの入力をそのまま使うか、エラーとするか選択
            // ここではユーザーの入力をそのまま使う（ただし、スプレッドシート側での日付解釈に依存する）
            console.warn(`AIによる期限 '${newDueRaw}' の解析に失敗、または「不明」と判断されました。元の入力を期限として使用します。`);
        }
    }
    
    try {
      const sheets = await getSheetsClient();
      // listRange ('シート1!A2:C') はヘッダーを除いたデータ範囲を指すため、
      // targetIndex はそのデータ配列のインデックス。
      // スプレッドシートの実際の行番号は targetIndex + 2 (A1形式)。
      const rangeToUpdate = `'シート1'!A${targetIndex + 2}:C${targetIndex + 2}`;
      
      await sheets.spreadsheets.values.update({
        spreadsheetId: sheetId,
        range: rangeToUpdate,
        valueInputOption: 'USER_ENTERED', // スプレッドシート側で日付等を解釈させる
        resource: {
          values: [[newType, newTask, newDue]],
        },
      });

      await modalInteraction.editReply({ content: `✅ 予定 (元のリストでの ${targetIndex + 1}番目) を更新しました。\n新しい内容:\n種別: ${newType}\n内容: ${newTask}\n期限: ${newDue}\n\nリストを最新の状態にするには、再度 \`/schedule\` コマンドを実行してください。` });
    } catch (error) {
      console.error('Error updating schedule in Google Sheets:', error);
      await modalInteraction.editReply({ content: '❌ スプレッドシートの予定更新中にエラーが発生しました。' });
    }
  }
};