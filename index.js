const fs = require('fs');
const { Client, Intents } = require('discord.js');
const discordModals = require('discord-modals');
const dotenv = require('dotenv');

dotenv.config();

const client = new Client({ intents: [Intents.FLAGS.GUILDS, Intents.FLAGS.GUILD_MESSAGES, Intents.FLAGS.DIRECT_MESSAGES] });
discordModals(client); // discord-modalsをセットアップ

const commands = {};
const commandFiles = fs.readdirSync('./commands').filter((file) => file.endsWith('.js'));

// ダミーのHTTPサーバーを起動して Render のポート監視を回避（必須ではないが安定化）
require('http').createServer((_, res) => res.end('Bot is running')).listen(process.env.PORT || 3000);

for (const file of commandFiles) {
  const command = require(`./commands/${file}`);
  commands[command.data.name] = command;
}

client.once('ready', async () => {
  console.log('Botが起動しました。');
  console.log('参加しているサーバー:');
  client.guilds.cache.forEach(async (guild) => {
    const updatedGuild = await guild.fetch();
    const owner = await client.users.fetch(updatedGuild.ownerId);
    console.log(`- サーバー名: ${updatedGuild.name}`);
    console.log(`- サーバーID: ${updatedGuild.id}`);
    console.log(`- オーナー名: ${owner.tag}`);
    console.log(`- オーナーID: ${updatedGuild.ownerId}`);
    console.log('--------------------------');
  });
});

client.once('ready', async () => {
  const data = [];
  for (const commandName in commands) {
    data.push(commands[commandName].data);
  }
  await client.application.commands.set(data);
  console.log('DiscordBotが起動しました。');
});

client.on('interactionCreate', async (interaction) => {
  if (interaction.isCommand()) {
    const command = commands[interaction.commandName];
    if (!command) return;

    try {
      await command.execute(interaction);
    } catch (error) {
      console.error(error);
      await interaction.reply({
        content: 'コマンドの内部でエラーが発生しました。',
        ephemeral: true,
      });
    }
  } else if (interaction.isModalSubmit()) {
    // モーダル送信イベントを処理する例
    if (interaction.customId === 'scheduleAddModal') {
      const { google } = require('googleapis');
      const sheets = google.sheets({ version: 'v4', auth: process.env.sheet_api_key });

      const type = interaction.getTextInputValue('typeInput');
      const task = interaction.getTextInputValue('taskInput');
      const due = interaction.getTextInputValue('dueInput');

      if (!/^\d{4}-\d{2}-\d{2}$/.test(due)) {
        await interaction.reply({ content: '❌ 期限は YYYY-MM-DD 形式で入力してください。', ephemeral: true });
        return;
      }

      try {
        await sheets.spreadsheets.values.append({
          spreadsheetId: '16Mf4f4lIyqvzxjx5Nj8zgvXXRyIZjGFtfQlNmjjzKig',
          range: 'シート1!A2:C',
          key: process.env.SHEET_API_KEY,  // ここにAPIキーを渡す
          valueInputOption: 'USER_ENTERED',
          requestBody: {
            values: [[type, task, due]],
          },
        });

        await interaction.reply({ content: `✅ 予定を追加しました:\n📌 **${type}**: ${task}（締切: ${due}）`, ephemeral: true });
      } catch (error) {
        console.error(error);
        await interaction.reply({ content: '❌ 予定の追加中にエラーが発生しました。', ephemeral: true });
      }
    }
  }
});

client.login(process.env.DISCORD_TOKEN);
