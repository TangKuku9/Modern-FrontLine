// 客户端武器系统 = 权威状态机 + 它的视图模型影子。
//
// 玩法裁决全在 js/weapon-state.js，画面全在 js/viewmodel.js。
// 服务端 import 前者，永远不会走到这个文件；这里唯一的工作是把两者接起来，
// 并保持 player.js / main.js / mp.js 看到的那张老面孔（ws.adsT、ws.w.mag…）。
import { WeaponState } from './weapon-state.js';
import { Viewmodel } from './viewmodel.js';

export class WeaponSystem extends WeaponState {
  constructor(game, owner) {
    super(game, owner);
    // 没有 vmScene 的进程就是不做渲染的权威服务端。那时连 Viewmodel 都不构造 ——
    // 于是"服务端悄悄跑了画面代码"这种事故会当场抛错，而不是安静地多算一份模型。
    this.vm = game.vmScene ? new Viewmodel(game, owner, this) : null;
  }
  // 渲染帧调用，与模拟 tick 解耦：高刷屏上枪的手感不再被 60Hz 绑住
  updateRender(dt) { if (this.vm) this.vm.update(dt); }
  dispose() { if (this.vm) this.vm.dispose(); super.dispose(); }
}
