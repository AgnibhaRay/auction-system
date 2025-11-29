package main

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"log"
	"net/http"
	"sync"
	"time"

	"github.com/gorilla/websocket"
	"github.com/redis/go-redis/v9"
)

// --- ☁️ REDIS CLOUD CONFIGURATION ---
// Paste your details from the Redis Cloud Dashboard here:
const (
	RedisAddr     = "redis-19053.c8.us-east-1-2.ec2.cloud.redislabs.com:19053" // "Public Endpoint"
	RedisPassword = "Sy6itE8KSoPDfoPr03aJczFtLhcsHx5L"                         // "Default User Password"
)

// --- GLOBAL VARIABLES ---
var ctx = context.Background()
var rdb *redis.Client

// --- CONSTANTS (Redis Keys) ---
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

// Local clients connected ONLY to THIS server instance
// We use a Mutex to ensure we don't crash when writing to multiple sockets at once
var clients = make(map[*websocket.Conn]bool)
var clientsMu sync.Mutex

// Message Protocol
type Message struct {
	Type     string `json:"type"` // "update", "bid", "start", "end"
	Username string `json:"username"`
	Amount   int    `json:"amount"`
	ItemName string `json:"item_name"`
	TimeLeft int    `json:"time_left"`
	Content  string `json:"content"` // For system messages/errors
}

func main() {
	// Parse command-line flags
	port := flag.String("port", "8080", "Port to run the server on")
	flag.Parse()

	// 1. Initialize Redis Connection
	initRedis()

	// 2. Start Redis Subscriber (Listens for updates from other servers)
	go subscribeToRedis()

	// 3. Start The Game Timer
	// NOTE: In a real production cluster, you would use a "Leader Election"
	// so only ONE server runs the timer. For this project, running it on one
	// specific terminal (or all of them redundantly) is acceptable for the MVP.
	go runTimer()

	// 4. Start HTTP Server
	http.HandleFunc("/ws", handleConnections)

	addr := ":" + *port
	fmt.Printf("🚀 Hand2Mart Server started on %s\n", addr)
	log.Fatal(http.ListenAndServe(addr, nil))
}

// --- REDIS CONNECTION ---
func initRedis() {
	rdb = redis.NewClient(&redis.Options{
		Addr:     RedisAddr,
		Password: RedisPassword,
		DB:       0, // Use default DB
	})

	// Test the connection immediately
	_, err := rdb.Ping(ctx).Result()
	if err != nil {
		log.Fatalf("❌ Failed to connect to Redis Cloud: %v\n(Check your Endpoint, Password, and Firewalls)", err)
	}
	fmt.Println("✅ Connected to Redis Cloud")
}

// --- LUA SCRIPT FOR ATOMIC BIDS ---
// We use explicit nil checks here to prevent "nonexistent global variable" errors
var bidScript = redis.NewScript(`
	local currentPriceVal = redis.call("GET", KEYS[1])
	local currentPrice = 0
	
	if currentPriceVal ~= false and currentPriceVal ~= nil then
		currentPrice = tonumber(currentPriceVal)
	end

	local newBid = tonumber(ARGV[1])
	
	if newBid > currentPrice then
		redis.call("SET", KEYS[1], newBid)      -- Set Price
		redis.call("SET", KEYS[2], ARGV[2])     -- Set Bidder
		return 1 -- Success
	else
		return 0 -- Fail
	end
`)

// --- CORE LOGIC ---

func subscribeToRedis() {
	// Subscribe to the global channel
	pubsub := rdb.Subscribe(ctx, ChannelUpdates)
	defer pubsub.Close()

	// Wait for messages
	ch := pubsub.Channel()
	for msg := range ch {
		// msg.Payload is the raw JSON string.
		// We simply forward this string to all local websocket clients.
		clientsMu.Lock()
		for client := range clients {
			err := client.WriteMessage(websocket.TextMessage, []byte(msg.Payload))
			if err != nil {
				client.Close()
				delete(clients, client)
			}
		}
		clientsMu.Unlock()
	}
}

func broadcastToRedis(msg Message) {
	// Convert Go Struct -> JSON String
	jsonMsg, _ := json.Marshal(msg)
	// Publish to Redis Channel
	rdb.Publish(ctx, ChannelUpdates, jsonMsg)
}

func runTimer() {
	ticker := time.NewTicker(1 * time.Second)
	defer ticker.Stop()

	for range ticker.C {
		// Only tick if auction is running
		running, _ := rdb.Get(ctx, KeyRunning).Bool()
		if running {
			// Decrement Time atomically
			timeLeft, _ := rdb.Decr(ctx, KeyTime).Result()

			// Fetch state to show on UI
			price, _ := rdb.Get(ctx, KeyPrice).Int()
			bidder, _ := rdb.Get(ctx, KeyBidder).Result()
			item, _ := rdb.Get(ctx, KeyItem).Result()

			if timeLeft > 0 {
				// Broadcast Tick
				broadcastToRedis(Message{
					Type: "update", ItemName: item, Amount: price,
					Username: bidder, TimeLeft: int(timeLeft),
				})
			} else {
				// Auction Ended
				rdb.Set(ctx, KeyRunning, false, 0)
				broadcastToRedis(Message{
					Type: "end", ItemName: item, Amount: price,
					Username: bidder, TimeLeft: 0, Content: "SOLD!",
				})
			}
		}
	}
}

func handleConnections(w http.ResponseWriter, r *http.Request) {
	// Upgrade HTTP -> WebSocket
	ws, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		return
	}
	defer ws.Close()

	// Register Client
	clientsMu.Lock()
	clients[ws] = true
	clientsMu.Unlock()

	// On Connect: Fetch current state from Redis immediately so UI isn't empty
	price, _ := rdb.Get(ctx, KeyPrice).Int()
	bidder, _ := rdb.Get(ctx, KeyBidder).Result()
	item, _ := rdb.Get(ctx, KeyItem).Result()
	timeLeft, _ := rdb.Get(ctx, KeyTime).Int()

	// Send direct message (no broadcast needed for initial sync)
	ws.WriteJSON(Message{
		Type: "update", ItemName: item, Amount: price,
		Username: bidder, TimeLeft: timeLeft,
	})

	// Listen for incoming messages
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
	// Set initial keys in Redis
	rdb.Set(ctx, KeyItem, msg.ItemName, 0)
	rdb.Set(ctx, KeyPrice, msg.Amount, 0)
	rdb.Set(ctx, KeyBidder, "House", 0)
	rdb.Set(ctx, KeyTime, 60, 0) // 60 Second Timer
	rdb.Set(ctx, KeyRunning, true, 0)

	// Announce to the world
	broadcastToRedis(Message{
		Type: "update", ItemName: msg.ItemName, Amount: msg.Amount,
		Username: "House", TimeLeft: 60,
	})
}

func processBid(msg Message) {
	// 1. Validation
	running, _ := rdb.Get(ctx, KeyRunning).Bool()
	if !running {
		return
	}

	// 2. Execute Atomic Lua Script
	keys := []string{KeyPrice, KeyBidder}
	values := []interface{}{msg.Amount, msg.Username}

	// Run script: Only updates if NewBid > CurrentPrice
	result, err := bidScript.Run(ctx, rdb, keys, values...).Int()
	if err != nil {
		log.Println("Redis Error:", err)
		return
	}

	// 3. If Script returned 1 (Success)
	if result == 1 {
		// Anti-Sniping: If time < 10s, add 10s
		timeLeft, _ := rdb.Get(ctx, KeyTime).Int()
		if timeLeft < 10 {
			rdb.IncrBy(ctx, KeyTime, 10)
		}

		// Broadcast success
		broadcastToRedis(Message{
			Type: "update", ItemName: msg.ItemName, Amount: msg.Amount,
			Username: msg.Username, TimeLeft: timeLeft,
		})
	}
}
