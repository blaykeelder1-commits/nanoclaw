# Email Deliverability DNS Setup

Set these DNS records for your sending domain to avoid spam filters.

## 1. SPF Record

Add a TXT record to your domain:

```
Type: TXT
Host: @
Value: v=spf1 ip4:YOUR_VPS_IP include:_spf.google.com ~all
```

Replace `YOUR_VPS_IP` with your Contabo VPS IP address.
If using Amazon SES later, add `include:amazonses.com`.

## 2. DKIM Record

Generate DKIM keys:

```bash
# On your VPS:
sudo apt-get install opendkim opendkim-tools
sudo opendkim-genkey -s nanoclaw -d yourdomain.com
sudo cat nanoclaw.txt  # This gives you the DNS record
```

Add the TXT record from the output:

```
Type: TXT
Host: nanoclaw._domainkey
Value: v=DKIM1; k=rsa; p=YOUR_PUBLIC_KEY
```

## 3. DMARC Record

```
Type: TXT
Host: _dmarc
Value: v=DMARC1; p=none; rua=mailto:dmarc@yourdomain.com; pct=100
```

Start with `p=none` (monitoring only), then move to `p=quarantine` after 2-4 weeks.

## 4. Reverse DNS (PTR Record)

Set in **Contabo Control Panel** (not your domain registrar):

1. Log into Contabo panel
2. Go to your VPS > Reverse DNS
3. Set the PTR record to: `mail.yourdomain.com`

Then add a matching A record:

```
Type: A
Host: mail
Value: YOUR_VPS_IP
```

## Verification

After setting up DNS records, verify with:

```bash
# Check SPF
dig TXT yourdomain.com

# Check DKIM
dig TXT nanoclaw._domainkey.yourdomain.com

# Check DMARC
dig TXT _dmarc.yourdomain.com

# Check reverse DNS
dig -x YOUR_VPS_IP
```

## Warm-Up Schedule

Week 1: 5 emails/day
Week 2: 10 emails/day
Week 3: 15 emails/day
Week 4+: 20 emails/day max

Monitor bounce rates. If bounces exceed 5%, pause and investigate.
