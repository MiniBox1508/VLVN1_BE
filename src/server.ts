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
const PORT = 3001;

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
    const parsed = Papa.parse(response.data, {
      header: true,
      skipEmptyLines: true,
    });
    leaderboardCache = parsed.data
      .filter((row: any) => row["Name"] && row["Name"].trim() !== "")
      .map((row: any) => ({
        position: row["Position"],
        prize: row["Prize"],
        name: row["Name"].trim(),
        matches: [
          Number(row["M1"]) || 0,
          Number(row["M2"]) || 0,
          Number(row["M3"]) || 0,
          Number(row["M4"]) || 0,
          Number(row["M5"]) || 0,
          Number(row["M6"]) || 0,
        ],
        total: Number(row["Total"]) || 0,
        totalPoint: Number(row["Total Point"]) || 0,
      }));
  } catch (error) {
    console.error("❌ Lỗi Leaderboard Sync");
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

    const parseDay = (
      startCol: number,
      lobbyCount: number,
      dayNum: number
    ): DayLobbies => {
      const rounds: Round[] = [];
      for (let r = 0; r < 6; r++) {
        const colIndex = startCol + r;
        const lobbies: Lobby[] = [];
        for (let l = 0; l < lobbyCount; l++) {
          const startRow = 1 + l * 9;
          const members: LobbyMember[] = [];
          for (let m = 0; m < 8; m++) {
            members.push({
              name: rows[startRow + m]?.[colIndex]?.trim() || "",
            });
          }
          lobbies.push({ lobbyName: `Lobby ${l + 1}`, members });
        }
        rounds.push({ roundNumber: r + 1, lobbies });
      }
      return { day: dayNum, rounds };
    };

    lobbiesData.day1 = parseDay(0, 8, 1);
    lobbiesData.day2 = parseDay(6, 5, 2);
  } catch (error) {
    console.error("❌ Lỗi Lobbies Sync");
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
    process.exit(1);
  }
};
start();
