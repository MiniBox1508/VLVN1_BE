import Fastify from "fastify";
import cors from "@fastify/cors";
import axios from "axios";
import Papa from "papaparse";
import cron from "node-cron";

// --- INTERFACES ---

export interface Player {
  summonerName: string;
  rankPoints: number;
  email?: string;
}

export interface LeaderboardEntry {
  position: string;
  prize: string;
  name: string;
  matches: number[];
  total: number;
  totalPoint: number;
}

export interface LobbyMember {
  name: string;
}

export interface Lobby {
  lobbyName: string;
  members: LobbyMember[];
}

export interface Round {
  roundNumber: number;
  lobbies: Lobby[];
}

export interface DayLobbies {
  day: number;
  rounds: Round[];
}

// Interface dùng chung cho phân trang
interface IPaginationParams {
  page?: string;
  limit?: string;
}

interface ILeaderboardSearchQuery extends IPaginationParams {
  name?: string;
  position?: string;
  total?: string;
  totalPoint?: string;
}

interface ILobbySearchQuery extends IPaginationParams {
  day?: string;
  round?: string;
  lobby?: string;
  name?: string;
}

// --- CẤU HÌNH ---
const server = Fastify({ logger: true });
const PORT = Number(process.env.PORT) || 3000;

const PLAYERS_SHEET_URL =
  "https://docs.google.com/spreadsheets/d/e/2PACX-1vT2toeLa-uxkhYyHjI4vb4qdhN2EdGHAJAmdvdpCxpRvYQXuzxRgS7Fpm9nMqdNBvFL5ksm71-fmbz0/pub?gid=1551656749&output=csv";
const LEADERBOARD_SHEET_URL =
  "https://docs.google.com/spreadsheets/d/e/2PACX-1vT2toeLa-uxkhYyHjI4vb4qdhN2EdGHAJAmdvdpCxpRvYQXuzxRgS7Fpm9nMqdNBvFL5ksm71-fmbz0/pub?gid=1043616930&output=csv";
const LOBBIES_SHEET_URL =
  "https://docs.google.com/spreadsheets/d/e/2PACX-1vT2toeLa-uxkhYyHjI4vb4qdhN2EdGHAJAmdvdpCxpRvYQXuzxRgS7Fpm9nMqdNBvFL5ksm71-fmbz0/pub?gid=791702275&output=csv";

// --- CACHE ---
let playersCache: Player[] = [];
let leaderboardCache: LeaderboardEntry[] = [];
let lobbiesData: { day1: DayLobbies | null; day2: DayLobbies | null } = {
  day1: null,
  day2: null,
};
let lastUpdated = new Date();

server.register(cors, { origin: "*" });

// --- UTILS (Hàm bổ trợ phân trang) ---
const paginate = (
  data: any[],
  page: string | undefined,
  limit: string | undefined
) => {
  const currentPage = parseInt(page || "1");
  const pageSize = parseInt(limit || "10");
  const startIndex = (currentPage - 1) * pageSize;
  const paginatedData = data.slice(startIndex, startIndex + pageSize);

  return {
    meta: {
      total: data.length,
      currentPage,
      pageSize,
      totalPages: Math.ceil(data.length / pageSize),
    },
    data: paginatedData,
  };
};

// --- SERVICES ---

async function syncPlayersData() {
  try {
    const response = await axios.get(PLAYERS_SHEET_URL);
    const parsed = Papa.parse(response.data, {
      header: true,
      skipEmptyLines: true,
    });
    playersCache = parsed.data
      .filter(
        (row: any) => row["SUMMONER NAME"] && row["SUMMONER NAME"].trim() !== ""
      )
      .map((row: any) => ({
        summonerName: row["SUMMONER NAME"].trim(),
        rankPoints: Number(row["RANK POINTS"]) || 0,
        email: row["EMAIL"] || "",
      }));
  } catch (error) {
    console.error("❌ Lỗi Players Sync");
  }
}

async function syncLeaderboardData() {
  try {
    const response = await axios.get(LEADERBOARD_SHEET_URL);

    // Bước 1: Parse thô (không lấy header tự động)
    const parsed = Papa.parse(response.data, {
      header: false, // Lấy dạng mảng của mảng
      skipEmptyLines: true,
    });

    const rows = parsed.data as string[][];
    if (rows.length === 0) return;

    // Bước 2: Tìm dòng chứa tiêu đề "Name"
    // Chúng ta duyệt qua các dòng đầu tiên để tìm dòng tiêu đề thực sự
    let headerIndex = rows.findIndex((row) =>
      row.some(
        (cell) => cell && cell.toString().trim().toLowerCase() === "name"
      )
    );

    if (headerIndex === -1) {
      console.error(
        "❌ Không tìm thấy dòng tiêu đề (Name, Position...) trong Sheet Leaderboard"
      );
      return;
    }

    // Bước 3: Xác định chỉ số (index) của từng cột
    const headerRow = rows[headerIndex]!.map((h) => h.trim().toLowerCase());
    const idx = {
      pos: headerRow.indexOf("position"),
      prize: headerRow.indexOf("prize"),
      name: headerRow.indexOf("name"),
      m1: headerRow.indexOf("m1"),
      m2: headerRow.indexOf("m2"),
      m3: headerRow.indexOf("m3"),
      m4: headerRow.indexOf("m4"),
      m5: headerRow.indexOf("m5"),
      m6: headerRow.indexOf("m6"),
      total: headerRow.indexOf("total"),
      totalPoint: headerRow.indexOf("total point"),
    };

    // Bước 4: Map dữ liệu từ các dòng sau dòng tiêu đề
    leaderboardCache = rows
      .slice(headerIndex + 1)
      .filter((row) => row[idx.name] && row[idx.name]!.trim() !== "") // Chỉ lấy dòng có tên
      .map((row) => ({
        position: row[idx.pos] || "",
        prize: row[idx.prize] || "",
        name: row[idx.name]!.trim(),
        matches: [
          Number(row[idx.m1]) || 0,
          Number(row[idx.m2]) || 0,
          Number(row[idx.m3]) || 0,
          Number(row[idx.m4]) || 0,
          Number(row[idx.m5]) || 0,
          Number(row[idx.m6]) || 0,
        ],
        total: Number(row[idx.total]) || 0,
        totalPoint: Number(row[idx.totalPoint]) || 0,
      }));

    console.log(
      `✅ Leaderboard: Đã tìm thấy tiêu đề tại dòng ${headerIndex + 1} và tải ${
        leaderboardCache.length
      } người.`
    );
  } catch (error) {
    console.error("❌ Lỗi Leaderboard Sync:", error);
  }
}

async function syncLobbiesData() {
  try {
    const response = await axios.get(LOBBIES_SHEET_URL);
    const parsed = Papa.parse(response.data, {
      header: false,
      skipEmptyLines: false,
    });
    const rows = parsed.data as string[][];

    // CẤU HÌNH THEO QUY LUẬT BẠN ĐÃ TÌM THẤY
    const CONFIG = {
      PLAYER_START_ROW: 4, // Dòng bắt đầu VĐV đầu tiên
      LOBBY_ROW_STEP: 9, // Khoảng cách giữa các Lobby (1 tiêu đề + 8 người)
      ROUND_COL_STEP: 5, // Mỗi Round cách nhau 5 cột
      DAY2_START_COL: 30, // Ngày 2 bắt đầu từ cột 30 (6 round x 5)
      TOTAL_ROUNDS: 6,
      TOTAL_LOBBIES: 8,
    };

    const parseDay = (startCol: number, dayNum: number): DayLobbies => {
      const rounds: Round[] = [];

      for (let r = 0; r < CONFIG.TOTAL_ROUNDS; r++) {
        // Tính vị trí cột chính xác của Round dựa trên bước nhảy 5
        const colIndex = startCol + r * CONFIG.ROUND_COL_STEP;
        const lobbies: Lobby[] = [];

        for (let l = 0; l < CONFIG.TOTAL_LOBBIES; l++) {
          const playerStartRow =
            CONFIG.PLAYER_START_ROW + l * CONFIG.LOBBY_ROW_STEP;
          const members: LobbyMember[] = [];

          for (let m = 0; m < 8; m++) {
            const val = rows[playerStartRow + m]?.[colIndex]?.trim() || "";
            members.push({ name: val });
          }

          lobbies.push({
            lobbyName: `Lobby ${l + 1}`,
            members,
          });
        }
        rounds.push({ roundNumber: r + 1, lobbies });
      }
      return { day: dayNum, rounds };
    };

    // Thực hiện đồng bộ vào Cache
    lobbiesData.day1 = parseDay(0, 1); // Day 1 bắt đầu từ cột 0
    lobbiesData.day2 = parseDay(CONFIG.DAY2_START_COL, 2); // Day 2 bắt đầu từ cột 30

    console.log(
      `✅ Lobbies: Đã đồng bộ Day 1 & Day 2 (Bước nhảy 5 cột, Hàng ${CONFIG.PLAYER_START_ROW})`
    );
  } catch (error) {
    console.error("❌ Lỗi Lobbies Sync:", error);
  }
}

async function syncAllData() {
  await Promise.allSettled([
    syncPlayersData(),
    syncLeaderboardData(),
    syncLobbiesData(),
  ]);
  lastUpdated = new Date();
  console.log(
    `✅ Toàn bộ dữ liệu đã được làm mới lúc: ${lastUpdated.toLocaleTimeString()}`
  );
}

cron.schedule("*/30 * * * * *", async () => {
  await syncAllData();
});

// --- API ENDPOINTS HEALTHCHECK---
server.get("/health", async () => ({ status: "ok" }));

// --- API ENDPOINTS ---

// 1. Players List & Search (Gộp chung logic phân trang)
server.get("/api/players", async (request) => {
  const { page, limit, q } = request.query as any;
  let data = playersCache;
  if (q)
    data = data.filter((p) =>
      p.summonerName.toLowerCase().includes(q.toLowerCase())
    );
  return {
    success: true,
    lastUpdated: lastUpdated.toLocaleString("vi-VN"),
    ...paginate(data, page, limit),
  };
});

// 2. Leaderboard Search (Có phân trang)
server.get("/api/leaderboard/search", async (request) => {
  const { name, position, total, totalPoint, page, limit } =
    request.query as ILeaderboardSearchQuery;
  let data = leaderboardCache;

  if (name)
    data = data.filter((e) =>
      e.name.toLowerCase().includes(name.toLowerCase())
    );
  if (position) data = data.filter((e) => e.position === position);
  if (total) data = data.filter((e) => e.total === Number(total));
  if (totalPoint)
    data = data.filter((e) => e.totalPoint === Number(totalPoint));

  return { success: true, ...paginate(data, page, limit) };
});

// 3. Leaderboard List (Mặc định)
server.get("/api/leaderboard", async (request) => {
  const { page, limit } = request.query as any;
  return { success: true, ...paginate(leaderboardCache, page, limit) };
});

// 4. Lobbies List theo ngày
server.get("/api/lobbies/:day", async (request: any, reply) => {
  const { day } = request.params;
  const result = day === "1" ? lobbiesData.day1 : lobbiesData.day2;
  if (!result)
    return reply
      .status(404)
      .send({ success: false, message: "Không tìm thấy dữ liệu" });
  return { success: true, data: result };
});

// 5. Lobbies Search (Có phân trang cho kết quả tìm kiếm phẳng)
server.get("/api/lobbies/search", async (request) => {
  const { day, round, lobby, name, page, limit } =
    request.query as ILobbySearchQuery;
  let daysToSearch =
    day === "1"
      ? [lobbiesData.day1]
      : day === "2"
      ? [lobbiesData.day2]
      : [lobbiesData.day1, lobbiesData.day2];

  const results: any[] = [];
  daysToSearch.forEach((d) => {
    d?.rounds.forEach((r) => {
      if (round && r.roundNumber !== parseInt(round)) return;
      r.lobbies.forEach((l) => {
        if (lobby && !l.lobbyName.includes(lobby)) return;
        l.members.forEach((m) => {
          if (!name || m.name.toLowerCase().includes(name.toLowerCase())) {
            results.push({
              day: d.day,
              round: r.roundNumber,
              lobby: l.lobbyName,
              player: m.name,
            });
          }
        });
      });
    });
  });

  return { success: true, ...paginate(results, page, limit) };
});

const start = async () => {
  try {
    await syncAllData();
    await server.listen({ port: PORT, host: "0.0.0.0" });
    console.log(`🚀 Server ready at http://localhost:${PORT}`);
  } catch (err) {
    server.log.error(err);
    process.exit(1);
  }
};
start();
