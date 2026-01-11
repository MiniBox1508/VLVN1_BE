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

interface IPaginationParams {
  page?: string;
  limit?: string;
}

interface ILeaderboardSearchQuery extends IPaginationParams {
  name?: string;
  position?: string;
  total?: string;
  totalPoint?: string;
  minPoint?: string; // Filter mới cho tìm kiếm nâng cao
}

interface ILobbySearchQuery extends IPaginationParams {
  day?: string;
  round?: string;
  lobby?: string;
  name?: string;
}

// --- CẤU HÌNH ---
const server = Fastify({ logger: true });
const PORT = Number(process.env.PORT) || 10000;

const PLAYERS_SHEET_URL =
  "https://docs.google.com/spreadsheets/d/e/2PACX-1vT2toeLa-uxkhYyHjI4vb4qdhN2EdGHAJAmdvdpCxpRvYQXuzxRgS7Fpm9nMqdNBvFL5ksm71-fmbz0/pub?gid=1551656749&output=csv";
const LEADERBOARD_SHEET_URL =
  "https://docs.google.com/spreadsheets/d/e/2PACX-1vT2toeLa-uxkhYyHjI4vb4qdhN2EdGHAJAmdvdpCxpRvYQXuzxRgS7Fpm9nMqdNBvFL5ksm71-fmbz0/pub?gid=1043616930&output=csv";
const LEADERBOARD2_SHEET_URL =
  "https://docs.google.com/spreadsheets/d/e/2PACX-1vT2toeLa-uxkhYyHjI4vb4qdhN2EdGHAJAmdvdpCxpRvYQXuzxRgS7Fpm9nMqdNBvFL5ksm71-fmbz0/pub?gid=558218408&output=csv";
const LOBBIES_SHEET_URL =
  "https://docs.google.com/spreadsheets/d/e/2PACX-1vT2toeLa-uxkhYyHjI4vb4qdhN2EdGHAJAmdvdpCxpRvYQXuzxRgS7Fpm9nMqdNBvFL5ksm71-fmbz0/pub?gid=791702275&output=csv";

// --- CACHE ---
let playersCache: Player[] = [];
let leaderboardCache: LeaderboardEntry[] = [];
let leaderboard2Cache: LeaderboardEntry[] = [];
let lobbiesData: { day1: DayLobbies | null; day2: DayLobbies | null } = {
  day1: null,
  day2: null,
};
let lastUpdated = new Date();

server.register(cors, { origin: "*" });

// --- UTILS ---
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

// --- LOGIC SẮP XẾP CHUNG ---
const sortLeaderboard = (data: LeaderboardEntry[]) => {
  return [...data].sort((a, b) => {
    // Ưu tiên 1: Total Point (Điểm tổng sắp) cao hơn xếp trên
    if (b.totalPoint !== a.totalPoint) return b.totalPoint - a.totalPoint;
    // Ưu tiên 2: Total (Tổng điểm các trận) cao hơn xếp trên
    return b.total - a.total;
  });
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
    const parsed = Papa.parse(response.data, {
      header: false,
      skipEmptyLines: true,
    });
    const rows = parsed.data as string[][];
    if (rows.length === 0) return;

    let headerIndex = rows.findIndex((row) =>
      row.some((cell) => cell?.toString().trim().toLowerCase() === "name")
    );
    if (headerIndex === -1) return;

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

    const rawData = rows
      .slice(headerIndex + 1)
      .filter((row) => row[idx.name]?.trim() !== "")
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

    // Cập nhật Cache với logic Sắp xếp
    leaderboardCache = sortLeaderboard(rawData);
    console.log(
      `✅ Leaderboard Day 1: Đã đồng bộ và sắp xếp ${leaderboardCache.length} kỳ thủ.`
    );
  } catch (error) {
    console.error("❌ Lỗi Leaderboard Sync:", error);
  }
}

async function syncLeaderboard2Data() {
  try {
    const response = await axios.get(LEADERBOARD2_SHEET_URL);
    const parsed = Papa.parse(response.data, {
      header: false,
      skipEmptyLines: true,
    });
    const rows = parsed.data as string[][];
    if (rows.length === 0) return;

    let headerIndex = rows.findIndex((row) =>
      row.some((cell) => cell?.toString().trim().toLowerCase() === "name")
    );
    if (headerIndex === -1) return;

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

    const rawData = rows
      .slice(headerIndex + 1)
      .filter((row) => row[idx.name]?.trim() !== "")
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

    // Cập nhật Cache với logic Sắp xếp
    leaderboard2Cache = sortLeaderboard(rawData);
    console.log(
      `✅ Leaderboard Day 2: Đã đồng bộ và sắp xếp ${leaderboard2Cache.length} kỳ thủ.`
    );
  } catch (error) {
    console.error("❌ Lỗi Leaderboard 2 Sync:", error);
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

    const CONFIG = {
      PLAYER_START_ROW: 4,
      LOBBY_ROW_STEP: 9,
      ROUND_COL_STEP: 5,
      DAY2_START_COL: 30,
      TOTAL_ROUNDS: 6,
      TOTAL_LOBBIES: 8,
    };

    const parseDay = (startCol: number, dayNum: number): DayLobbies => {
      const rounds: Round[] = [];
      for (let r = 0; r < CONFIG.TOTAL_ROUNDS; r++) {
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
          lobbies.push({ lobbyName: `Lobby ${l + 1}`, members });
        }
        rounds.push({ roundNumber: r + 1, lobbies });
      }
      return { day: dayNum, rounds };
    };

    lobbiesData.day1 = parseDay(0, 1);
    lobbiesData.day2 = parseDay(CONFIG.DAY2_START_COL, 2);
  } catch (error) {
    console.error("❌ Lỗi Lobbies Sync:", error);
  }
}

async function syncAllData() {
  await Promise.allSettled([
    syncPlayersData(),
    syncLeaderboardData(),
    syncLeaderboard2Data(),
    syncLobbiesData(),
  ]);
  lastUpdated = new Date();
}

cron.schedule("*/30 * * * * *", async () => {
  await syncAllData();
});

// --- API ENDPOINTS ---

server.get("/health", async () => ({
  status: "ok",
  lastSync: lastUpdated.toLocaleString("vi-VN"),
}));

// --- API MỚI: TOP PERFORMERS (Vinh danh Top 3) ---
server.get("/api/leaderboard/top-performers", async () => {
  return {
    success: true,
    day1: leaderboardCache.slice(0, 3), // Top 3 Day 1
    day2: leaderboard2Cache.slice(0, 3), // Top 3 Day 2
    timestamp: lastUpdated.toLocaleString("vi-VN"),
  };
});

server.get("/api/players", async (request) => {
  const { page, limit, q } = request.query as any;
  let data = playersCache;
  if (q)
    data = data.filter((p) =>
      p.summonerName.toLowerCase().includes(q.toLowerCase())
    );
  return { success: true, ...paginate(data, page, limit) };
});

server.get("/api/leaderboard", async (request) => {
  const { page, limit } = request.query as any;
  return { success: true, ...paginate(leaderboardCache, page, limit) };
});

server.get("/api/leaderboard/search", async (request) => {
  const { name, minPoint, page, limit } =
    request.query as ILeaderboardSearchQuery;
  let data = leaderboardCache;
  if (name)
    data = data.filter((e) =>
      e.name.toLowerCase().includes(name.toLowerCase())
    );
  if (minPoint) data = data.filter((e) => e.totalPoint >= Number(minPoint)); // Filter điểm tối thiểu
  return { success: true, ...paginate(data, page, limit) };
});

server.get("/api/leaderboard2", async (request) => {
  const { page, limit } = request.query as any;
  return { success: true, ...paginate(leaderboard2Cache, page, limit) };
});

server.get("/api/lobbies/:day", async (request: any, reply) => {
  const { day } = request.params;
  const result = day === "1" ? lobbiesData.day1 : lobbiesData.day2;
  if (!result)
    return reply.status(404).send({ success: false, message: "Not found" });
  return { success: true, data: result };
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
