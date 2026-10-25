# Independent recomputation of one health factor: public RPC, none of the watchdog's code, the market's stored totals (no interest accrual).
# Usage: python3 -I independent-check.py   (compare with: npm run liquidation-watchdog -- position --market 0xc79579a0…fd86 --user 0xA4A57DcF…3DCc)
import json,urllib.request,sys
RPC="https://rpc.pharos.xyz"
M="0x18573fA18fd17dDfD790B4a5B5b2977aad3b4Efb"
ID="c79579a002dbc8c535d3a87198fcbbece1a664ad82a356b0447c5bff9e16fd86"
U="A4A57DcF7B15456b7053f10A377Bdb437C073DCc"
def call(to,data):
    r=urllib.request.Request(RPC,json.dumps({"jsonrpc":"2.0","id":1,"method":"eth_call","params":[{"to":to,"data":data},"latest"]}).encode(),{"content-type":"application/json","user-agent":"curl/8"})
    j=json.load(urllib.request.urlopen(r)); return j.get("result") or sys.exit(str(j))
w=lambda h,i:int(h[2+i*64:2+(i+1)*64],16)
sel={"idToMarketParams(bytes32)":"2c3c9157","market(bytes32)":"5c60e39a","position(bytes32,address)":"93c52062","price()":"a035b1fe"}
p=call(M,"0x"+sel["idToMarketParams(bytes32)"]+ID); oracle="0x"+p[2+2*64+24:2+3*64]; lltv=w(p,4)
m=call(M,"0x"+sel["market(bytes32)"]+ID); tba,tbs=w(m,2),w(m,3)
pos=call(M,"0x"+sel["position(bytes32,address)"]+ID+"0"*24+U); bs,coll=w(pos,1),w(pos,2)
price=int(call(oracle,"0x"+sel["price()"]),16)
debt=-(-bs*(tba+1)//(tbs+10**6))
maxb=coll*price//10**36*lltv//10**18
print("lltv",lltv/1e18,"price",price,"collateral",coll/1e18,"debt(stale totals)",debt/1e6,"HF",maxb/debt)
