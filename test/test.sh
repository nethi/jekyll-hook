# $1 = JSON file to simulate the webhook push event  (webhook-gitlab-example.json)
curl -H "content-type:application/json" -X POST  --data "@$1" http://localhost:8080/hooks/jekyll/:master

