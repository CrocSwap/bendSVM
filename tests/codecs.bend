import Base

type Point is Data:
  Point{x: U32, y: U32}

type Packet is Data:
  Idle{}
  Enabled{flag: Bool}
  Number{value: U32}
  Location{flag: Bool, point: Point}

def identity(packet: Packet) -> Packet:
  packet

def flip(packet: Packet) -> Packet:
  match packet:
    case Idle{}:
      Idle{}
    case Enabled{flag}:
      Enabled{Bool.not(flag)}
    case Number{value}:
      Number{U32.not(value)}
    case Location{flag, Point{x, y}}:
      Location{Bool.not(flag), Point{y, x}}

law identity_preserves:
  for packet: Packet
  {identity(packet) == packet : Packet}

def identity_preserves(packet):
  {==}
