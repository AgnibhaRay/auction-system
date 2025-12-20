package main

import (
	"context"
	"database/sql" // <--- NEW
	"encoding/json"
	"flag"
	"fmt"
	"log"
	"net/http"
	"sync"
	"time"

	"github.com/gorilla/websocket"
	_ "github.com/lib/pq" // <--- NEW: Postgres Driver
	"github.com/redis/go-redis/v9"
)

// --- CONFIGURATION ---
const (
	// Redis (Speed Layer)
	RedisAddr     = "redis-15534.c276.us-east-1-2.ec2.cloud.redislabs.com:15534"
	RedisPassword = "Y1IUIUF34LAt4hvSxlB6lseKNW7tRqkd"

	// Postgres (Persistence Layer)
	// Format: "postgres://user:password@host:port/dbname?sslmode=disable"
	PostgresConnStr = "postgres://avnadmin:AVNS_vmO3jLRgWQVfsKzrnB2@pg-3272af03-agnibharay-125c.l.aivencloud.com:28257/defaultdb?sslmode=require"
)

// --- GLOBAL VARIABLES ---
var ctx = context.Background()
var rdb *redis.Client
var db *sql.DB // <--- NEW: SQL Database Handler

// --- CONSTANTS ---
const (
	KeyPrice       = "auction:price"
	KeyBidder      = "auction:bidder"
	KeyItem        = "auction:item"
	KeyTime        = "auction:time"
	KeyRunning     = "auction:running"
	ChannelUpdates = "auction:updates"
)

// --- WEBSOCKET SETUP ---
var upgrader = websocket.Upgrader{
	CheckOrigin: func(r *http.Request) bool { return true },
}

var clients = make(map[*websocket.Conn]bool)
var clientsMu sync.Mutex

type Message struct {
	Type     string `json:"type"`
	Username string `json:"username"`
	Amount   int    `json:"amount"`
	ItemName string `json:"item_name"`
	TimeLeft int    `json:"time_left"`
	Content  string `json:"content"`
}

func main() {
	portFlag := flag.String("port", "8080", "Port to run the server on")
	flag.Parse()

	// 1. Initialize Databases
	initRedis()
	initPostgres() // <--- NEW

	// 2. Start Logic
	go subscribeToRedis()
	go runTimer()

	// 3. Start HTTP
	http.HandleFunc("/ws", handleConnections)

	addr := ":" + *portFlag
	fmt.Printf("🚀 Hand2Mart Server started on %s\n", addr)
	log.Fatal(http.ListenAndServe(addr, nil))
}

// --- DATABASE CONNECTIONS ---

func initRedis() {
	rdb = redis.NewClient(&redis.Options{
		Addr:     RedisAddr,
		Password: RedisPassword,
		DB:       0,
	})
	_, err := rdb.Ping(ctx).Result()
	if err != nil {
		log.Fatalf("❌ Redis Error: %v", err)
	}
	fmt.Println("✅ Connected to Redis Cloud")
}

func initPostgres() {
	var err error
	db, err = sql.Open("postgres", PostgresConnStr)
	if err != nil {
		log.Fatalf("❌ Postgres Config Error: %v", err)
	}

	err = db.Ping()
	if err != nil {
		log.Fatalf("❌ Could not ping Postgres: %v", err)
	}
	fmt.Println("✅ Connected to PostgreSQL")

	// Create the bids table if it doesn't exist
	createTableSQL := `
	CREATE TABLE IF NOT EXISTS bids (
		id SERIAL PRIMARY KEY,
		item_name VARCHAR(255) NOT NULL,
		bidder_name VARCHAR(255) NOT NULL,
		amount INTEGER NOT NULL,
		created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
	)`

	_, err = db.Exec(createTableSQL)
	if err != nil {
		log.Fatalf("❌ Failed to create bids table: %v", err)
	}
	fmt.Println("✅ Bids table ready")
}

// --- PERSISTENCE LOGIC (ASYNC) ---

func saveBidToDB(item string, bidder string, amount int) {
	// This runs in a background goroutine so it doesn't slow down the auction!
	query := `INSERT INTO bids (item_name, bidder_name, amount) VALUES ($1, $2, $3)`

	_, err := db.Exec(query, item, bidder, amount)
	if err != nil {
		// In production, you might send this to a logging service (Datadog/Sentry)
		log.Printf("⚠️ Failed to save bid to SQL: %v", err)
	} else {
		// Optional: Print to console just to show it's working
		fmt.Printf("💾 Persisted bid: %s @ $%d by %s\n", item, amount, bidder)
	}
}

// --- REDIS LOGIC ---

var bidScript = redis.NewScript(`
	local currentPriceVal = redis.call("GET", KEYS[1])
	local currentPrice = 0
	if currentPriceVal ~= false and currentPriceVal ~= nil then
		currentPrice = tonumber(currentPriceVal)
	end
	local newBid = tonumber(ARGV[1])
	if newBid > currentPrice then
		redis.call("SET", KEYS[1], newBid)
		redis.call("SET", KEYS[2], ARGV[2])
		return 1
	else
		return 0
	end
`)

func subscribeToRedis() {
	pubsub := rdb.Subscribe(ctx, ChannelUpdates)
	defer pubsub.Close()
	ch := pubsub.Channel()
	for msg := range ch {
		clientsMu.Lock()
		for client := range clients {
			client.WriteMessage(websocket.TextMessage, []byte(msg.Payload))
		}
		clientsMu.Unlock()
	}
}

func broadcastToRedis(msg Message) {
	jsonMsg, _ := json.Marshal(msg)
	rdb.Publish(ctx, ChannelUpdates, jsonMsg)
}

func runTimer() {
	ticker := time.NewTicker(1 * time.Second)
	defer ticker.Stop()
	for range ticker.C {
		running, _ := rdb.Get(ctx, KeyRunning).Bool()
		if running {
			timeLeft, _ := rdb.Decr(ctx, KeyTime).Result()
			price, _ := rdb.Get(ctx, KeyPrice).Int()
			bidder, _ := rdb.Get(ctx, KeyBidder).Result()
			item, _ := rdb.Get(ctx, KeyItem).Result()

			if timeLeft > 0 {
				broadcastToRedis(Message{Type: "update", ItemName: item, Amount: price, Username: bidder, TimeLeft: int(timeLeft)})
			} else {
				rdb.Set(ctx, KeyRunning, false, 0)
				broadcastToRedis(Message{Type: "end", ItemName: item, Amount: price, Username: bidder, TimeLeft: 0, Content: "SOLD!"})
			}
		}
	}
}

func handleConnections(w http.ResponseWriter, r *http.Request) {
	ws, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		return
	}
	defer ws.Close()

	clientsMu.Lock()
	clients[ws] = true
	clientsMu.Unlock()

	price, _ := rdb.Get(ctx, KeyPrice).Int()
	bidder, _ := rdb.Get(ctx, KeyBidder).Result()
	item, _ := rdb.Get(ctx, KeyItem).Result()
	timeLeft, _ := rdb.Get(ctx, KeyTime).Int()

	ws.WriteJSON(Message{Type: "update", ItemName: item, Amount: price, Username: bidder, TimeLeft: timeLeft})

	for {
		var msg Message
		err := ws.ReadJSON(&msg)
		if err != nil {
			clientsMu.Lock()
			delete(clients, ws)
			clientsMu.Unlock()
			break
		}
		if msg.Type == "bid" {
			processBid(msg)
		} else if msg.Type == "start" {
			startAuction(msg)
		}
	}
}

func startAuction(msg Message) {
	rdb.Set(ctx, KeyItem, msg.ItemName, 0)
	rdb.Set(ctx, KeyPrice, msg.Amount, 0)
	rdb.Set(ctx, KeyBidder, "House", 0)
	rdb.Set(ctx, KeyTime, 60, 0)
	rdb.Set(ctx, KeyRunning, true, 0)
	broadcastToRedis(Message{Type: "update", ItemName: msg.ItemName, Amount: msg.Amount, Username: "House", TimeLeft: 60})
}

func processBid(msg Message) {
	running, _ := rdb.Get(ctx, KeyRunning).Bool()
	if !running {
		return
	}
	keys := []string{KeyPrice, KeyBidder}
	values := []interface{}{msg.Amount, msg.Username}

	// 1. Attempt Atomic Redis Update
	result, err := bidScript.Run(ctx, rdb, keys, values...).Int()
	if err != nil {
		log.Println("Redis Error:", err)
		return
	}

	// 2. If Redis accepted the bid...
	if result == 1 {
		// 3. ...Trigger the SQL Write in the BACKGROUND (Goroutine)
		// This makes the system extremely fast because we don't wait for SQL
		//Implement Kafka if necessary for better durability
		//Implemet ORM for production level code
		go saveBidToDB(msg.ItemName, msg.Username, msg.Amount)

		timeLeft, _ := rdb.Get(ctx, KeyTime).Int()
		if timeLeft < 10 {
			rdb.IncrBy(ctx, KeyTime, 10)
		}
		broadcastToRedis(Message{Type: "update", ItemName: msg.ItemName, Amount: msg.Amount, Username: msg.Username, TimeLeft: timeLeft})
	}
}
