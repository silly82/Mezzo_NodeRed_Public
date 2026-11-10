# Mezzo_NodeRed – Node-RED-Plugin für Powersoft-Verstärker

Node-RED-Nodes zum **Steuern und Überwachen von Powersoft-Verstärkern** über das native
Powersoft-Protokoll (UDP) – ohne Armonía, ohne Zusatzhardware.

Paketname: `node-red-contrib-powersoft-mezzo` · Aktuelle Version: **0.3.0**
([Releases](https://github.com/silly82/Mezzo_NodeRed_Public/releases))

**Getestet mit:** Powersoft **Mezzo 324 A** (Firmware 1.6.1.24) und **Nota 142** (Firmware 1.2.4.0), Node-RED 4.x,
FlowFuse Dashboard 1.35.

> **Vorschau Nota 142 / DC Rider:** Nodes für Nota 142 und DC Rider (Protokoll PBusX) sind enthalten –
> siehe [Nota 142 / DC Rider (Vorschau)](#nota-142--dc-rider-vorschau). Der **Nota 142** ist am Gerät getestet
> (Firmware 1.2.4.0), der **DC Rider** ist nach der Powersoft-Spezifikation umgesetzt, aber **noch nicht am Gerät
> getestet**. Enthalten ab Release **0.3.0**.

> Dies ist der öffentliche Download-Stand (Plugin + Anleitung). Fragen und Fehlermeldungen bitte über
> *Issues* in diesem Repository.

---

## Inhalt

1. [Funktionen](#funktionen)
2. [Voraussetzungen](#voraussetzungen)
3. [Installation](#installation)
4. [Schnellstart](#schnellstart)
5. [Die Nodes](#die-nodes)
6. [Befehlsreferenz](#befehlsreferenz)
7. [Statusobjekt](#statusobjekt)
8. [Messwerte (Meter)](#messwerte-meter)
9. [Beispiel-Flows](#beispiel-flows)
10. [Dashboard](#dashboard)
11. [Erweiterte Mezzo-Funktionen (ungetestet)](#erweiterte-mezzo-funktionen-ungetestet)
12. [Nota 142 / DC Rider (Vorschau)](#nota-142--dc-rider-vorschau)
13. [Wichtige Hinweise](#wichtige-hinweise)
14. [Fehlersuche](#fehlersuche)
15. [Lizenz](#lizenz)

---

## Funktionen

**Steuern**

- Power / Standby, LED-Identifikation (Blink)
- Lautstärke pro Kanal: absolut in dB, relativ als Taster (+/−) oder per Schrittwert (z.B. Drehgeber)
- Mute, Gain und Polarität im User-Block pro Kanal
- Ausgänge (Ways): Gain, Mute
- Eingänge (Matrix Pre): Gain, Mute
- Matrix: Gain und Mute jedes der 16 Kreuzpunkte
- Nickname, Auto Power Down, Reboot, Rohzugriff (Schreiben auf beliebige Adresse)

**Überwachen**

- Gerätedaten: Modell, Seriennummer, Firmware, MAC, Netzwerk
- Standby-Zustand, Alarme (Lüfter, Übertemperatur, Netzteil, Aux, Generic Fault, Fault-Code)
- Alarme pro Kanal und Schutz-Mutes mit Ursache
- Netzspannung, Rails, Hilfsspannungen, Lüfterstrom, Temperaturen
- Alle Gain-/Mute-/Polaritäts-/Delay-Einstellungen und die Matrix
- Messwerte: Ausgangsspannung und -strom, Signalpräsenz, Headroom, Limiter, Eingangspegel

**Komfort**

- Netzwerksuche: Mezzo-Auswahlmenü im Konfigurationsdialog, IP-Feld mit Verbindungstest
- Warnung, wenn unter der IP plötzlich ein anderes Gerät antwortet (Seriennummer-Prüfung)
- Statusausgabe nur bei Änderung, bei jedem Poll oder auf Anfrage
- Sicherheitsgrenze +15 dB für alle Gains; einstellbarer Bereich (Standard −60…+15 dB)
- **mezzo-value**: ein einzelner Wert pro Node (lesen + schreiben) – Dashboard-Widgets direkt anschließen
- Fertiges Dashboard (FlowFuse Dashboard 2) mit 5 Seiten

---

## Voraussetzungen

| Komponente | Version |
|---|---|
| Node.js | ≥ 14 |
| Node-RED | ≥ 2.0 (getestet mit 4.x) |
| Verstärker | Powersoft Mezzo (getestet: Mezzo 324 A); Vorschau: Nota 142 (getestet), DC Rider (ungetestet) |
| Netzwerk | Mezzo: UDP Port 8002; Nota / DC Rider: UDP 8082 und 12345 (Suche/Blink); für die Gerätesuche dasselbe Subnetz |
| Dashboard (optional) | `@flowfuse/node-red-dashboard` ≥ 1.x |

Das Plugin hat **keine npm-Abhängigkeiten**.

---

## Installation

### Variante A – direkt aus GitHub (empfohlen)

Im Node-RED-Benutzerverzeichnis (meist `~/.node-red`, unter Windows `%USERPROFILE%\.node-red`):

```sh
cd ~/.node-red
npm install github:silly82/Mezzo_NodeRed_Public
```

Danach **Node-RED neu starten**. Die Nodes erscheinen in der Palette in der Kategorie **Powersoft**.

Aktualisieren: denselben Befehl erneut ausführen und Node-RED neu starten.

Eine bestimmte Version installieren (z.B. 0.3.0): `npm install github:silly82/Mezzo_NodeRed_Public#v0.3.0`

### Variante B – ZIP herunterladen

1. Unter [*Releases*](https://github.com/silly82/Mezzo_NodeRed_Public/releases) die ZIP-Datei
   (`node-red-contrib-powersoft-mezzo-0.3.0.zip`) herunterladen – oder auf GitHub **Code → Download ZIP**.
2. Entpacken, z.B. nach `~/mezzo-plugin`.
3. Installieren:

   ```sh
   cd ~/.node-red
   npm install ~/mezzo-plugin
   ```

   (Windows: `npm install C:\Pfad\zum\entpackten\Ordner`)
4. Node-RED neu starten.

### Variante C – Docker / Node-RED-Container

```sh
docker exec -it <container> sh -c "cd /data && npm install github:silly82/Mezzo_NodeRed_Public"
docker restart <container>
```

### Dashboard (optional)

Für das Beispiel-Dashboard zusätzlich *Menü → Palette verwalten → Installieren* →
`@flowfuse/node-red-dashboard`, oder:

```sh
cd ~/.node-red
npm install @flowfuse/node-red-dashboard
```

### Deinstallieren

```sh
cd ~/.node-red
npm uninstall node-red-contrib-powersoft-mezzo
```

---

## Schnellstart

1. Einen **mezzo-status**-Node in den Flow ziehen und doppelklicken.
2. Bei *Verstärker* auf den Stift ✎ klicken → der Konfigurationsdialog sucht automatisch im Netzwerk.
3. Im Menü **Mezzo** den gefundenen Verstärker auswählen – IP, Name, Modell und Seriennummer werden ausgefüllt.
   Alternativ die IP von Hand eintragen und mit **Testen** prüfen.
4. Einen **debug**-Node anhängen und deployen → bei jeder Zustandsänderung kommt das Statusobjekt.
5. Zum Steuern einen **mezzo-control**-Node verwenden, z.B. Befehl *Lautstärke +* mit Kanal 1, davor einen
   inject-Node.

Oder direkt einen der [Beispiel-Flows](#beispiel-flows) importieren.

---

## Die Nodes

### mezzo-amp – Verstärker-Konfiguration

Eine Instanz pro Verstärker. Hält die Verbindung, fragt den Status zyklisch ab und verteilt ihn an alle
Status- und Control-Nodes dieses Verstärkers.

| Feld | Bedeutung | Standard |
|---|---|---|
| **Mezzo** | Auswahlmenü mit den gefundenen Verstärkern. 🔄 sucht erneut. Die Auswahl füllt IP, Name, Modell und SN aus. | – |
| **IP-Adresse** | IP oder Hostname. **Testen** prüft, ob dort ein Mezzo antwortet. | – |
| Name | Anzeigename | Nickname oder Modell |
| Modell / SN | nur Anzeige; die SN dient zur Kontrolle, ob unter der IP noch das richtige Gerät antwortet | – |
| UDP Port | Steuerport des Mezzo | 8002 |
| Status-Poll (s) | Intervall der Statusabfrage | 2 |
| Meter-Poll (s) | Intervall der Messwertabfrage, `0` = aus | 0 |
| Timeout (ms) | Wartezeit pro Anfrage (2 Wiederholungen) | 1000 |

- Stimmt die gelesene SN nicht mit der gespeicherten überein, erscheint eine **Warnung im Log**
  (z.B. nach IP-Wechsel per DHCP).
- Bei Verbindungsverlust werden alle angeschlossenen Nodes rot markiert.

### mezzo-status

Gibt Status und optional Messwerte aus.

| Feld | Bedeutung |
|---|---|
| Verstärker | mezzo-amp-Konfiguration |
| Ausgabe | **bei Zustandsänderung** (Standard), **bei jedem Poll** oder **nur auf Input-Message** |
| Meter | Messwerte zusätzlich ausgeben (dazu im Config-Node *Meter-Poll* > 0 setzen) |

**Eingang** (optional):

| `msg.topic` | Wirkung |
|---|---|
| leer oder `status` | Status sofort lesen und ausgeben |
| `meters` | Messwerte sofort lesen und ausgeben |
| `read` mit `msg.payload = {address, size}` | Rohdaten lesen |

**Ausgang**:

| `msg.topic` | `msg.payload` |
|---|---|
| `status` | [Statusobjekt](#statusobjekt) |
| `meters` | [Messwerte](#messwerte-meter) |
| `connection` | `{connected: true/false, error}` |

Der Node-Status zeigt *on* (grün), *standby* (grau), *alarm* (gelb) oder *disconnected* (rot).

### mezzo-control

Führt Steuerbefehle aus. Danach wird der Status sofort neu gelesen.

| Feld | Bedeutung | Standard |
|---|---|---|
| Verstärker | mezzo-amp-Konfiguration | – |
| Befehl | fester Befehl oder **aus msg.topic** | aus msg.topic |
| Kanal | 1–4, *alle*, oder *aus msg / alle* | aus msg / alle |
| Quelle / Ausgang | für Matrix-Befehle | aus msg |
| Gain-Block | für Lautstärke-Befehle: User, Output oder Input Gain | User Gain |
| Schritt dB | Schrittweite der Lautstärke-Taster | 1 |
| Min / Max | Bereich für Taster und absolute Gains | −60 / +15 |

**Eingang**:

| Eigenschaft | Bedeutung |
|---|---|
| `msg.topic` | Befehl (wenn im Node *aus msg.topic* gewählt) |
| `msg.payload` | Wert: boolean (`true/false`, `1/0`, `"on"/"off"`, `"ein"/"aus"`), Zahl in dB (`null`/`"off"` = −∞), Text für `nickname` |
| `msg.channel` | Kanal 1–4 oder `"all"`; ohne Angabe gilt der Befehl für **alle** Kanäle |
| `msg.source`, `msg.output` | Matrix-Kreuzpunkt: Quelle 1–4, Ausgang 1–4 (= A–D) |
| `msg.step`, `msg.min`, `msg.max`, `msg.block` | überschreiben die Einstellungen im Node |

Alternativ als Objekt: `msg.payload = {command, value, channel, source, output, step, min, max}`.

**Ausgang**: die Eingangs-Message mit `msg.result`:

```js
{
  ok: true,
  command: "gain", value: -12.5, channel: 2,
  appliedDb: -12.5,     // tatsächlich gesetzter Wert
  clamped: false,       // true, wenn auf Min/Max begrenzt wurde
  changes: [            // bei volumeUp/volumeDown/gainStep
    { channel: 1, fromDb: -3, toDb: -2, atLimit: false }
  ]
}
```

Fehler werden als Node-Fehler gemeldet und können mit einem **catch**-Node abgefangen werden.

### mezzo-value

**Ein einzelner Wert** – lesen und schreiben. Ideal für Dashboards: jedes Widget bekommt seinen eigenen
mezzo-value-Node, ohne Function-Nodes und ohne Verteilung über Topics.

```
[mezzo value: User Gain CH2] ──► [Dashboard-Eingabefeld] ──► zurück in denselben mezzo value
```

| Feld | Bedeutung | Standard |
|---|---|---|
| Verstärker | mezzo-amp-Konfiguration | – |
| Wert | Auswahlliste (gruppiert): Gerät, Versorgung, Kanal, Matrix, Messwerte. ✎ = schreibbar | User Gain |
| Kanal / Eingang → Ausgang | je nach Wert | 1 |
| Ausgabe | **Wert** (Zahl/boolean – für Schalter, Eingabefeld, Gauge) oder **Text mit Einheit** (für Textanzeigen) | Wert |
| Untergrenze | kleinere Werte und −∞ werden darauf gesetzt (z.B. −60 für Gauges) | keine |
| Min / Max dB | Bereich beim Schreiben von Gains | −60 / +15 |

**Ausgang** – nur bei Änderung (und beim Start): `msg.payload` (Wert oder Text), zusätzlich immer
`msg.value`, `msg.text`, `msg.unit`; `msg.topic` z.B. `userGain:2`.

**Eingang** – `msg.payload` schreibt den Wert (dB, boolean, Text). Danach gibt der Node immer den tatsächlichen
Gerätewert aus; begrenzte oder abgelehnte Eingaben springen so im Widget auf den echten Wert zurück.
`msg.topic = "refresh"` gibt den aktuellen Wert erneut aus.

Verfügbare Werte: Power, Standby, Alarm, Fault, Nickname, Auto Power Down, IP, Modell, SN, Firmware ·
Netzspannung, Temperaturen, Rails, Aux, Lüfterstrom · pro Kanal User/Output/Input Gain und Mute, Polarität,
Delays, Way-Name, Kanaltemperatur, Kanal-Alarm · Matrix Route/Gain/Mute · Messwerte Eingang RMS/Peak,
Ausgangsspannung/-strom, Leistung, Headroom, Limiter, Signal (Messwerte brauchen *Meter-Poll* > 0).

---

## Befehlsreferenz

Kanalbezogene Befehle wirken ohne Kanalangabe auf **alle vier Kanäle**.

| Befehl | payload | Wirkung |
|---|---|---|
| `power` | `true` / `false` | `true` = einschalten, `false` = Standby |
| `standby` | `true` / `false` | `true` = Standby, `false` = einschalten |
| `blink` | `true` / `false` (leer = `true`) | LED-Identifikation |
| `volumeUp` | egal | Gain um *Schritt* dB erhöhen (bis Max) |
| `volumeDown` | egal | Gain um *Schritt* dB senken (bis Min) |
| `gainStep` | Zahl (dB, ±) | Gain relativ ändern (Drehgeber) |
| `outputGainStep`, `inputGainStep` | Zahl (dB, ±) | dasselbe für Output- bzw. Input-Gain |
| `gain` | dB, `null`/`"off"` | User-Gain absolut |
| `mute` | boolean | User-Mute |
| `polarity` | boolean | Polarität invertieren |
| `outputGain` / `outputMute` | dB / boolean | Ausgang (Way) |
| `inputGain` / `inputMute` | dB / boolean | Eingang (Matrix Pre) |
| `matrixGain` | dB, `"off"` | Kreuzpunkt `source` → `output` (`"off"` = nicht geroutet) |
| `matrixMute` | boolean | Mute Kreuzpunkt |
| `nickname` | Text (max. 79 Zeichen) | Nickname setzen |
| `autoPowerDown` | boolean | automatischer Standby nach 25 min ohne Signal |
| `reboot` | egal | Verstärker neu starten |
| `write` | `{address, data}` | Rohzugriff (Hex-String, Byte-Array oder Buffer) |

**Gains**: Angabe in dB, Dezimalkomma wird akzeptiert, Rundung auf 0,1 dB. Werte über **+15 dB** werden
abgelehnt bzw. begrenzt. `null`, `"off"`, `"-inf"` = −∞ (aus).

**Lautstärke-Taster**: Vor jedem Schritt wird der aktuelle Wert vom Gerät gelesen; schnelle Tastenfolgen werden
nacheinander abgearbeitet. Beim Herunterregeln bleibt der Kanal bei *Min* stehen (nicht −∞).

### Beispiele

```js
// Trigger: CH1 auf -15 dB (fertig als examples/mezzo-trigger-demo.json)
msg.topic = "gain"; msg.channel = 1; msg.payload = -15;

// Kanal 2 stumm
msg.topic = "mute"; msg.channel = 2; msg.payload = true;

// alle Kanäle auf -10 dB
msg.topic = "gain"; msg.payload = -10;

// Kanal 1 einen Schritt lauter
msg.topic = "volumeUp"; msg.channel = 1;

// Drehgeber: Kanal 3 um -2 dB
msg.topic = "gainStep"; msg.channel = 3; msg.payload = -2;

// Matrix: Eingang 1 zusätzlich auf Ausgang B mit -6 dB
msg.topic = "matrixGain"; msg.source = 1; msg.output = 2; msg.payload = -6;
```

---

## Statusobjekt

`msg.payload` bei `msg.topic = "status"`. Arrays haben 4 Einträge, **Index 0 = Kanal 1**. Gains in dB,
`null` = −∞.

```js
{
  info:      { model: "DMZO324_ND", serial: "…", firmware: "1.6.1.24", mac: "…" },
  nickname:  "…",
  network:   { ip: "192.168.1.50", netmask: "255.255.255.0", gateway: "192.168.1.1" },
  standby:   false,
  on:        true,
  autoPowerDown: false,
  supply: {
    tempTransformer: 26.6, tempHeatsink: 29.9,   // °C
    mainsVrms: 240.5,                            // V
    vccP: 57.16, vccN: -57.26,                   // Rails, V
    vauxP: 10.54, vauxN: -10.68,                 // V
    fanCurrent: 0.013                            // A
  },
  channelTemp: [27.8, 29.3, 29.7, 29.7],
  alarms: {
    any: false,
    fan: false, highOverTemperature: false, psTemperature: false, vaux: false, genericFault: false,
    faultCode: 0, fault: "No Fault", faults: [],
    soaThermal: [false, …], temperature: [false, …], vrail: [false, …],
    protectionMutes: [[], [], [], []]            // z.B. ["Short circuit"]
  },
  user:   { gainDb: [0, 0, 0, 0], mute: [false, …], polarityInverted: [false, …], delay: [0, …] },
  output: { name: ["-", …], gainDb: […], mute: […], polarityInverted: […], delay: […] },
  input:  { gainDb: […], mute: […] },
  matrix: { gainDb: [[0, null, null, null], …], mute: [[false, …], …] },   // [Quelle][Ausgang]
  timestamp: "…"
}
```

---

## Messwerte (Meter)

`msg.payload` bei `msg.topic = "meters"` (Meter-Poll im Config-Node aktivieren, z.B. 1 s):

```js
{
  output: {
    vPeak: […], vRms: […],              // V
    iPeak: […], iRms: […],              // A
    signalPresence: [false, …],
    headroom: […], headroomDb: […],
    gainReduction: […], gainReductionDb: […]   // Limiter
  },
  input: { peak: […], rms: […], peakDb: […], rmsDb: […] },   // dBFS, null = kein Signal
  timestamp: "…"
}
```

---

## Beispiel-Flows

Im Ordner [`examples/`](examples). Import über *Node-RED-Menü → Importieren → Datei auswählen*
(oder *Importieren → Beispiele → node-red-contrib-powersoft-mezzo*).
Nach dem Import im Config-Node **den Verstärker auswählen bzw. die IP anpassen** (voreingestellt: 192.168.1.50).

| Datei | Inhalt | Benötigt |
|---|---|---|
| `mezzo-basic.json` | Minimalbeispiel: Status bei Änderung, Power, Blink, Mute CH1, Gain | – |
| `mezzo-dashboard.json` | Ausführliches Dashboard „Mezzo Dashboard“ | Dashboard 2 |
| `mezzo-trigger-demo.json` | Demo „Trigger → CH1 −15 dB“: beliebige Message (Inject, link-in „Trigger CH1 −15 dB“, MQTT …) setzt CH1 auf −15 dB, Rücksetzen auf 0 dB | – |
| `nota-dashboard.json` | Dashboard „Nota“ für Nota 142 / DC Rider (Vorschau): Übersicht, Kanäle, Messwerte, Matrix | Dashboard 2 |

---

## Dashboard

`examples/mezzo-dashboard.json` ist eine fertige Bedienoberfläche mit FlowFuse Dashboard 2,
erreichbar unter `http://<node-red>:1880/dashboard/mezzo`.

| Seite | Inhalt |
|---|---|
| **Übersicht** | Zustand, Power/Standby/Blink, ALLE ±; pro Kanal Lautstärke, Eingabe −60…+15 dB, `−` / `0 dB` / `+`, Mute, Pegel |
| **Kanäle** | pro Kanal User-, Output- und Input-Einstellungen |
| **Messwerte** | Gauges und Trends: Pegel, Spannung, Strom, Leistung, Headroom, Limiter, Temperatur, Netzspannung |
| **Matrix** | 16 Kreuzpunkte mit Route ein/aus, Gain, Mute |
| **Gerät & Alarme** | Geräteinfo, Nickname, Auto Power Down, Versorgung, Alarmtabellen |

Jedes Widget hängt an seinem eigenen mezzo-value-Node – übersichtliche Verdrahtung ohne Verteiler-Functions.
Popup-Meldungen bei Alarm, Verbindungsverlust, Standby-Wechsel und Fehlern.
Schalter zeigen immer den tatsächlichen Gerätezustand.

---

## Erweiterte Mezzo-Funktionen (ungetestet)

Nach der Powersoft-Spezifikation 1.4.0 umgesetzt, aber **noch nicht an einem Mezzo getestet** – vor dem Einsatz
prüfen, Werte zuerst klein wählen. Parameter als Objekt in `msg.payload` an einen mezzo-control-Node; die Werte
stehen im Status unter `sources`, `pilotTone`, `loadMonitor`, `gpio` (`null`, wenn das Gerät den Bereich
ablehnt) und im mezzo-value-Node.

| Funktion | Befehle (Beispiele) | Status / Werte |
|---|---|---|
| **Quellenwahl / Backup** | `backupEnable`, `sourcePriority` {channel, value: [2,1,3,4]}, `sourceDefaultPriority`, `sourceId`, `backupThresholdMode`, `backupThreshold` | `sources`, Gruppe „Quellenwahl“ |
| **Pilotton** | `pilotGenerator` {channel, enable, frequency, amplitude}, `pilotDetect` {channel, enable, frequency, low, high}, `pilotSource` {…, gpo} | `pilotTone` (`alarm`, `missing`), Gruppe „Pilotton“ |
| **Lastüberwachung** | `loadMonitor` {channel, enable, frequency, low, high}, `loadSensibility` (0,01–10 Vrms, flüchtig) | `loadMonitor` (`impedance` Ω, `outOfRange`), Gruppe „Lastüberwachung“ |
| **GPI / GPO** | `gpiMode` (gain/other), `relayMode` (automatic/manual), `relay` (true = geschlossen) | `gpio`, Gruppe „GPI/GPO“ |

Beispiel Lautsprecherüberwachung:
`{command: "loadMonitor", channel: 1, value: {enable: true, frequency: 20000, low: 4, high: 16}}`
→ `loadOutOfRange` (mezzo-value) meldet eine Last ausserhalb 4–16 Ω. Die Impedanz wird laut Spezifikation mit
Pilotton gemessen. Einheiten mancher Grenzwerte gibt die Spezifikation nicht an.

---

## Nota 142 / DC Rider (Vorschau)

Für die Powersoft-Geräte mit dem Protokoll **PBusX** gibt es eine eigene Node-Familie mit demselben Aufbau wie
die Mezzo-Nodes: **pbusx-amp** (Config), **pbusx-status**, **pbusx-control**, **pbusx-value** – ebenfalls in der
Palettenkategorie **Powersoft**. Die Bedienung ist in der Node-Hilfe (Info-Seitenleiste) beschrieben.

| Gerät | Stand |
|---|---|
| Nota 142 | am Gerät getestet (Firmware 1.2.4.0): Gerätesuche, Status, Meter, Lautstärke/Mute/Polarität/Delay, Matrix, Blink, Dashboard |
| DC Rider | nach der Powersoft-Spezifikation umgesetzt, **noch nicht am Gerät getestet** – vor dem Einsatz prüfen |

- **Gerätesuche** per Broadcast (UDP 12345), liefert auch die MAC; Verbindungstest per IP. *Blink* läuft über PBusX.
  Port: der Nota meldet UDP 8082, die DC-Rider-Spezifikation nennt 8002 – die Suche übernimmt den gemeldeten Port.
- Die Zahl der Eingänge und Kanäle wird am Gerät ermittelt.
- **Befehle**: `blink`, `gain`, `mute`, `polarity`, `delay` (ms), `outputGain`, `outputMute`, `outputPolarity`,
  `matrixGain`, `matrixMute`, `inputGain`/`inputMute`, `nickname`, `volumeUp`/`volumeDown`/`gainStep`, `write`.
  Nur DC Rider: `standby`/`power`, `reboot` (payload `"reboot"`).
- **Status**: Gerätename, Nickname, Temperatur, Rail-Spannung, User-/Way-Werte, Way-Name, Matrix, Eingangs-Gain/Mute,
  Alarme (Gerät, Kanal inkl. Kurzschluss, Eingang); DC Rider zusätzlich Rails, Batteriespannungen, Temperatur °C, Standby.
- **Meter**: Eingang Peak/RMS (gewählte Quelle), Ausgangsspannung/-strom, Signal, Clip, Headroom, Limiter-Gain-Reduktion (dB).
- **Nur Nota** (nach Powersoft-Spezifikation, am Nota 142 geprüft): Quellenwahl/Backup (`backupEnable`, `sourcePriority` …),
  Pilotton (`pilotSource`, `pilotGenerator`), Lastüberwachung mit Impedanz (`loadMonitor`), Zone (`zoneGain`, `zoneMute`),
  `microphone`, User-EQ (`userEq`), Dynamic EQ (`dynamicEq`), AES67-Routing (`aes67Route`);
  Status `sources`, `pilotTone`, `loadMonitor`, `zone`, `userEq`, `dynamicEq`, `aes67Routing`.
- **Dashboard**: `examples/nota-dashboard.json`, erreichbar unter `http://<node-red>:1880/dashboard/nota`.

---

## Wichtige Hinweise

- **Nur eine Steuerverbindung**: Der Mezzo akzeptiert nur einen Steuer-Client zur Zeit. Pro Verstärker nur
  **einen** mezzo-amp-Config-Node verwenden und Armonía Plus nicht gleichzeitig verbinden.
- **Auto Turn On** wird von Firmware 1.6.1.24 nicht gelesen und ist deshalb nicht verfügbar.
- **Andere Powersoft-Serien**: Die mezzo-Nodes sprechen nur das Mezzo-Protokoll. **Nota 142** und **DC Rider**
  haben eigene Nodes (`pbusx-*`, Vorschau – DC Rider noch nicht am Gerät getestet). X-Serie und Unica sprechen
  andere Protokolle und werden nicht unterstützt.
- **Gerätesuche** funktioniert nur im selben Subnetz. In anderen Netzen die IP von Hand eintragen.
- **Reboot** und **Raw Write** mit Bedacht einsetzen.
- Verwendung auf eigene Verantwortung – vor allem bei angeschlossenen Lautsprechern Gains vorsichtig ändern.

---

## Fehlersuche

| Symptom | Ursache / Lösung |
|---|---|
| Nodes erscheinen nicht in der Palette | Node-RED nach der Installation neu gestartet? Im richtigen Ordner (`~/.node-red`) installiert? |
| Node rot „timeout (IP:8002)“ | IP falsch, Gerät aus, Firewall blockiert UDP 8002, anderes Subnetz ohne Route |
| Auswahlmenü findet nichts | Broadcast wird nicht durchgelassen (anderes Subnetz/VLAN) → IP manuell eintragen und *Testen* |
| *Testen* meldet „no Mezzo answering“ | Unter der IP antwortet kein Mezzo auf Port 8002 |
| Warnung „device at … has serial …“ | Unter der IP antwortet ein anderes Gerät (z.B. DHCP) → im Dialog neu auswählen |
| „device rejected write (NAK)“ | Register wird von dieser Firmware nicht unterstützt |
| „gain … above safety limit 15 dB“ | Wert > +15 dB |
| Werte springen zurück | Anderer Client (Armonía, zweiter Config-Node) schreibt ebenfalls |
| Dashboard zeigt nichts | Dashboard 2 installiert? Seite `/dashboard/mezzo`; Verstärker im Config-Node gewählt? |

---

## Lizenz

MIT – siehe [LICENSE](LICENSE).

Powersoft, Mezzo und Armonía sind Marken der Powersoft S.p.A. Dieses Projekt ist kein offizielles Produkt
von Powersoft und steht in keiner Verbindung zum Hersteller.
