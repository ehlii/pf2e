import { ModeOfBeing } from "@actor/creature/types";
import { ActorAlliance, ActorDimensions, AuraData, SaveType } from "@actor/types";
import { ArmorPF2e, ContainerPF2e, ItemPF2e, PhysicalItemPF2e, type ConditionPF2e } from "@item";
import { ConditionSlug } from "@item/condition/data";
import { isCycle } from "@item/container/helpers";
import { ItemSourcePF2e, ItemType, PhysicalItemSource } from "@item/data";
import { hasInvestedProperty } from "@item/data/helpers";
import { EffectFlags, EffectSource } from "@item/effect/data";
import type { ActiveEffectPF2e } from "@module/active-effect";
import { TokenPF2e } from "@module/canvas";
import { ChatMessagePF2e } from "@module/chat-message";
import { Size } from "@module/data";
import { preImportJSON } from "@module/doc-helpers";
import { MigrationList, MigrationRunner } from "@module/migration";
import { RuleElementSynthetics } from "@module/rules";
import { RuleElementPF2e } from "@module/rules/rule-element/base";
import { RollOptionRuleElement } from "@module/rules/rule-element/roll-option";
import { LocalizePF2e } from "@module/system/localize";
import { UserPF2e } from "@module/user";
import { TokenDocumentPF2e } from "@scene";
import { DicePF2e } from "@scripts/dice";
import { eventToRollParams } from "@scripts/sheet-util";
import { Statistic } from "@system/statistic";
import { ErrorPF2e, isObject, objectHasKey, tupleHasValue } from "@util";
import type { CreaturePF2e } from "./creature";
import { VisionLevel, VisionLevels } from "./creature/data";
import { ActorDataPF2e, ActorSourcePF2e, ActorType } from "./data";
import { ActorFlagsPF2e, BaseTraitsData, PrototypeTokenDataPF2e, RollOptionFlags } from "./data/base";
import { ActorSizePF2e } from "./data/size";
import { ActorInventory } from "./inventory";
import { ItemTransfer } from "./item-transfer";
import { ActorSheetPF2e } from "./sheet/base";
import { ActorSpellcasting } from "./spellcasting";
import { TokenEffect } from "./token-effect";
import { CREATURE_ACTOR_TYPES } from "./values";

/**
 * Extend the base Actor class to implement additional logic specialized for PF2e.
 * @category Actor
 */
class ActorPF2e extends Actor<TokenDocumentPF2e, ItemTypeMap> {
    /** Has this actor gone through at least one cycle of data preparation? */
    private initialized?: true;

    /** A separate collection of owned physical items for convenient access */
    inventory!: ActorInventory;

    /** A separate collection of owned spellcasting entries for convenience */
    spellcasting!: ActorSpellcasting;

    /** Rule elements drawn from owned items */
    rules!: RuleElementPF2e[];

    synthetics!: RuleElementSynthetics;

    /** Data from rule elements for auras this actor may be emanating */
    auras!: Map<string, AuraData>;

    saves?: { [K in SaveType]?: Statistic };

    /** A cached copy of `Actor#itemTypes`, lazily regenerated every data preparation cycle */
    private _itemTypes?: { [K in keyof ItemTypeMap]: Embedded<ItemTypeMap[K]>[] };

    constructor(data: PreCreate<ActorSourcePF2e>, context: ActorConstructorContextPF2e = {}) {
        if (context.pf2e?.ready) {
            // Set module art if available
            if (context.pack && data._id) {
                const art = game.pf2e.system.moduleArt.get(`Compendium.${context.pack}.${data._id}`);
                if (art) {
                    data.img = art.actor;
                    const tokenArt =
                        typeof art.token === "string"
                            ? { img: art.token }
                            : { ...art.token, flags: { pf2e: { autoscale: false } } };
                    data.prototypeToken = mergeObject(data.prototypeToken ?? {}, tokenArt);
                }
            }

            super(data, context);
        } else {
            mergeObject(context, { pf2e: { ready: true } });
            const ActorConstructor = CONFIG.PF2E.Actor.documentClasses[data.type];
            return ActorConstructor ? new ActorConstructor(data, context) : new ActorPF2e(data, context);
        }
    }

    /** Cache the return data before passing it to the caller */
    override get itemTypes(): { [K in keyof ItemTypeMap]: Embedded<ItemTypeMap[K]>[] } {
        return (this._itemTypes ??= super.itemTypes);
    }

    get allowedItemTypes(): (ItemType | "physical")[] {
        return ["condition", "effect"];
    }

    /** The compendium source ID of the actor **/
    get sourceId(): ActorUUID | null {
        return this.flags.core?.sourceId ?? null;
    }

    /** The recorded schema version of this actor, updated after each data migration */
    get schemaVersion(): number | null {
        return Number(this.system.schema?.version) || null;
    }

    /** Get an active GM or, failing that, a player who can update this actor */
    get primaryUpdater(): UserPF2e | null {
        const activeUsers = game.users.filter((u) => u.active);

        // 1. The first active GM, sorted by ID
        const firstGM = activeUsers
            .filter((u) => u.isGM)
            .sort((a, b) => (a.id > b.id ? 1 : -1))
            .shift();
        if (firstGM) return firstGM;

        // 2. The user with this actor assigned
        const primaryPlayer = this.isToken ? null : activeUsers.find((u) => u.character?.id === this.id);
        if (primaryPlayer) return primaryPlayer;

        // 3. Anyone who can update the actor
        const firstUpdater = game.users
            .filter((u) => this.canUserModify(u, "update"))
            .sort((a, b) => (a.id > b.id ? 1 : -1))
            .shift();
        return firstUpdater ?? null;
    }

    /** Shortcut to system-data attributes */
    get attributes(): this["data"]["data"]["attributes"] {
        return this.system.attributes;
    }

    get hitPoints(): HitPointsSummary | null {
        const { hp } = this.system.attributes;
        if (!hp) return null;

        return {
            value: hp.value,
            max: hp.max,
            temp: hp.temp,
            negativeHealing: hp.negativeHealing,
        };
    }

    get traits(): Set<string> {
        return new Set(this.system.traits.traits.value);
    }

    get level(): number {
        return this.system.details.level.value;
    }

    get size(): Size {
        return this.system.traits.size.value;
    }

    /**
     * With the exception of vehicles, actor heights aren't specified. For the purpose of three-dimensional
     * token-distance measurement, however, the system will generally treat actors as cubes.
     */
    get dimensions(): ActorDimensions {
        const { size } = this.system.traits;
        return {
            length: size.length,
            width: size.width,
            height: Math.min(size.length, size.width),
        };
    }

    /**
     * Whether the actor can see, given its token placement in the current scene.
     * A meaningful implementation is found in `CreaturePF2e`.
     */
    get canSee(): boolean {
        return true;
    }

    /** Whether this actor can execute actions: meaningful implementations are found in `CreaturePF2e`. */
    get canAct(): boolean {
        return true;
    }

    /** Whether this actor can attack: meaningful implementations are found in `CreaturePF2e` and `HazardPF2e`. */
    get canAttack(): boolean {
        return false;
    }

    get modeOfBeing(): ModeOfBeing {
        const { traits } = this;
        return traits.has("undead") ? "undead" : traits.has("construct") ? "construct" : "living";
    }

    get visionLevel(): VisionLevel {
        return VisionLevels.NORMAL;
    }

    get rollOptions(): RollOptionFlags {
        return this.flags.pf2e.rollOptions;
    }

    /** Get the actor's held shield. Meaningful implementation in `CreaturePF2e`'s override. */
    get heldShield(): Embedded<ArmorPF2e> | null {
        return null;
    }

    /** Most actor types can host rule elements */
    get canHostRuleElements(): boolean {
        return true;
    }

    get alliance(): ActorAlliance {
        return this.system.details.alliance;
    }

    /** @deprecated */
    get physicalItems() {
        console.warn("ActorPF2e#physicalItems is deprecated: use ActorPF2e#inventory instead");
        return this.inventory;
    }

    /** Add effect icons from effect items and rule elements */
    override get temporaryEffects(): TemporaryEffect[] {
        const tokenIcon = (condition: ConditionPF2e): ImagePath => {
            const folder = CONFIG.PF2E.statusEffects.effectsIconFolder;
            const statusName = condition.system.hud.statusName;
            return `${folder}${statusName}.webp`;
        };
        const conditionTokenIcons = this.itemTypes.condition.map((condition) => tokenIcon(condition));
        const conditionTokenEffects = Array.from(new Set(conditionTokenIcons)).map((icon) => new TokenEffect(icon));

        const effectTokenEffects = this.itemTypes.effect
            .filter((effect) => effect.system.tokenIcon?.show)
            .map((effect) => new TokenEffect(effect.img));

        return super.temporaryEffects
            .concat(this.system.tokenEffects)
            .concat(conditionTokenEffects)
            .concat(effectTokenEffects);
    }

    /** A means of checking this actor's type without risk of circular import references */
    isOfType(type: "creature"): this is CreaturePF2e;
    isOfType<T extends ActorType>(
        ...types: T[]
    ): this is InstanceType<ConfigPF2e["PF2E"]["Actor"]["documentClasses"][T]>;
    isOfType<T extends ActorType | "creature">(...types: T[]): boolean {
        return types.some((t) => (t === "creature" ? tupleHasValue(CREATURE_ACTOR_TYPES, this.type) : this.type === t));
    }

    /** Whether this actor is an ally of the provided actor */
    isAllyOf(actor: ActorPF2e): boolean {
        return this.alliance !== null && this.alliance === actor.alliance;
    }

    /** Get roll options from this actor's effects, traits, and other properties */
    getSelfRollOptions(prefix: "self" | "target" | "origin" = "self"): string[] {
        const { rollOptions } = this;
        return Object.keys(rollOptions.all).flatMap((o) =>
            o.startsWith("self:") && rollOptions.all[o] ? o.replace(/^self/, prefix) : []
        );
    }

    /** The actor's reach: a meaningful implementation is found in `CreaturePF2e` and `HazardPF2e`. */
    getReach(_options: { action?: "interact" | "attack" }): number {
        return 0;
    }

    /** Create a clone of this actor to recalculate its statistics with temporary roll options included */
    getContextualClone(rollOptions: string[]): this {
        const rollOptionsAll = rollOptions.reduce(
            (options: Record<string, boolean>, option) => ({ ...options, [option]: true }),
            {}
        );
        return this.clone({ flags: { pf2e: { rollOptions: { all: rollOptionsAll } } } }, { keepId: true });
    }

    /** Apply effects from an aura: will later be expanded to handle effects from measured templates */
    async applyAreaEffects(aura: AuraData, { origin }: { origin: ActorPF2e }): Promise<void> {
        if (game.user !== this.primaryUpdater) return;

        const toCreate: EffectSource[] = [];
        for (const data of aura.effects) {
            if (this.itemTypes.effect.some((e) => e.sourceId === data.uuid)) {
                continue;
            }

            if (data.affects === "allies" && this.isAllyOf(origin)) {
                const effect = await fromUuid(data.uuid);
                if (!(effect instanceof ItemPF2e && effect.isOfType("effect"))) {
                    console.warn(`Effect from ${data.uuid} not found`);
                    continue;
                }

                const flags: DeepPartial<EffectFlags> = {
                    core: { sourceId: effect.uuid },
                    pf2e: {
                        aura: {
                            slug: aura.slug,
                            origin: origin.uuid,
                            removeOnExit: data.removeOnExit,
                        },
                    },
                };

                const source = mergeObject(effect.toObject(), { flags });
                source.system.level.value = data.level ?? source.data.level.value;
                source.system.duration.unit = "unlimited";
                source.system.duration.expiry = null;
                toCreate.push(source);
            }
        }

        if (toCreate.length > 0) {
            await this.createEmbeddedDocuments("Item", toCreate);
        }
    }

    /** Review `removeOnExit` aura effects and remove any that no longer apply */
    async checkAreaEffects(): Promise<void> {
        if (!canvas.ready || game.user !== this.primaryUpdater) return;

        const thisTokens = this.getActiveTokens(false, true);
        const toDelete: string[] = [];
        const toKeep: string[] = [];

        for (const effect of this.itemTypes.effect) {
            const auraData = effect.flags.pf2e.aura;
            if (!auraData?.removeOnExit) continue;

            const auraToken = await (async (): Promise<TokenDocumentPF2e | null> => {
                const document = await fromUuid(auraData.origin);
                if (document instanceof TokenDocumentPF2e) {
                    return document;
                } else if (document instanceof ActorPF2e) {
                    return document.getActiveTokens(false, true).shift() ?? null;
                }
                return null;
            })();

            const aura = auraToken?.auras.get(auraData.slug);

            // Main sure this isn't an identically-slugged aura with different effects
            const effects = auraToken?.actor?.auras.get(auraData.slug)?.effects ?? [];
            const auraHasEffect = effects.some((e) => e.uuid === effect.sourceId);

            for (const token of thisTokens) {
                if (auraHasEffect && aura?.containsToken(token)) {
                    toKeep.push(effect.id);
                } else {
                    toDelete.push(effect.id);
                }
            }

            // If no tokens for this actor remain in the scene, always remove the effect
            if (thisTokens.length === 0) {
                toDelete.push(effect.id);
            }
        }

        // In case there are multiple tokens for this actor, avoid deleting aura effects if at least one token is
        // exposed to the aura
        const finalToDelete = toDelete.filter((id) => !toKeep.includes(id));
        if (finalToDelete.length > 0) {
            await this.deleteEmbeddedDocuments("Item", finalToDelete);
        }
    }

    /**
     * As of Foundry 0.8: All subclasses of ActorPF2e need to use this factory method rather than having their own
     * overrides, since Foundry itself will call `ActorPF2e.create` when a new actor is created from the sidebar.
     */
    static override async createDocuments<A extends ConstructorOf<ActorPF2e>>(
        this: A,
        data: PreCreate<InstanceType<A>["data"]["_source"]>[] = [],
        context: DocumentModificationContext<InstanceType<A>> = {}
    ): Promise<InstanceType<A>[]> {
        // Set additional defaults, some according to actor type
        for (const datum of data) {
            const { linkToActorSize } = datum.prototypeToken?.flags?.pf2e ?? {};
            const merged = mergeObject(datum, {
                permission: datum.permission ?? { default: CONST.DOCUMENT_PERMISSION_LEVELS.NONE },
                prototypeToken: {
                    flags: {
                        // Sync token dimensions with actor size?
                        pf2e: {
                            linkToActorSize: linkToActorSize ?? !["hazard", "loot"].includes(datum.type),
                        },
                    },
                },
            });

            // Set default token dimensions for familiars and vehicles
            const dimensionMap: { [K in ActorType]?: number } = { familiar: 0.5, vehicle: 2 };
            merged.prototypeToken.height ??= dimensionMap[datum.type] ?? 1;
            merged.prototypeToken.width ??= merged.prototypeToken.height;

            switch (merged.type) {
                case "character":
                case "familiar":
                    merged.permission.default = CONST.DOCUMENT_PERMISSION_LEVELS.LIMITED;
                    // Default characters and their minions to having tokens with vision and an actor link
                    merged.prototypeToken.actorLink = true;
                    merged.prototypeToken.vision = true;
                    break;
                case "loot":
                    // Make loot actors linked and interactable
                    merged.prototypeToken.actorLink = true;
                    merged.permission.default = CONST.DOCUMENT_PERMISSION_LEVELS.LIMITED;
                    break;
            }
        }

        return super.createDocuments(data, context) as Promise<InstanceType<A>[]>;
    }

    protected override _initialize(): void {
        this.auras = new Map();
        this.rules = [];

        super._initialize();
        this.initialized = true;

        if (game._documentsReady) {
            this.synthetics.preparationWarnings.flush();
        }
    }

    /** Prepare token data derived from this actor, refresh Effects Panel */
    override prepareData(): void {
        delete this._itemTypes;

        super.prepareData();

        this.preparePrototypeToken();
        if (this.initialized && canvas.ready) {
            const thisTokenIsControlled = this.getActiveTokens().some((t) => !!t.isControlled);
            if (game.user.character === this || thisTokenIsControlled) {
                game.pf2e.effectPanel.refresh();
            }
        }
    }

    /** Prepare baseline ephemeral data applicable to all actor types */
    override prepareBaseData(): void {
        super.prepareBaseData();
        this.system.tokenEffects = [];
        this.system.autoChanges = {};
        this.system.attributes.flanking = { canFlank: false, canGangUp: [], flankable: false, flatFootable: false };
        this.system.toggles = [];

        const notTraits: BaseTraitsData | undefined = this.system.traits;
        if (notTraits?.size) notTraits.size = new ActorSizePF2e(notTraits.size);

        // Setup the basic structure of pf2e flags with roll options, preserving options in the "all" domain
        const { flags } = this;
        const rollOptionsAll = flags.pf2e?.rollOptions?.all ?? {};
        rollOptionsAll[`self:type:${this.type}`] = true;
        flags.pf2e = mergeObject({}, flags.pf2e ?? {});
        flags.pf2e.rollOptions = { all: rollOptionsAll };

        this.setEncounterRollOptions();

        const preparationWarnings: Set<string> = new Set();

        this.synthetics = {
            damageDice: { damage: [] },
            criticalSpecalizations: { standard: [], alternate: [] },
            modifierAdjustments: { all: [] },
            multipleAttackPenalties: {},
            rollNotes: {},
            rollSubstitutions: {},
            rollTwice: {},
            senses: [],
            statisticsModifiers: {},
            strikeAdjustments: [],
            strikes: new Map(),
            striking: {},
            weaponPotency: {},
            preparationWarnings: {
                add: (warning: string) => preparationWarnings.add(warning),
                flush: foundry.utils.debounce(() => {
                    for (const warning of preparationWarnings) {
                        console.warn(warning);
                    }
                    preparationWarnings.clear();
                }, 10), // 10ms also handles separate module executions
            },
        };

        // Reset auras from rule elements
        this.auras.clear();
    }

    /** Prepare the physical-item collection on this actor, item-sibling data, and rule elements */
    override prepareEmbeddedDocuments(): void {
        super.prepareEmbeddedDocuments();
        const physicalItems: Embedded<PhysicalItemPF2e>[] = this.items.filter(
            (item) => item instanceof PhysicalItemPF2e
        );
        this.inventory = new ActorInventory(this, physicalItems);

        const spellcastingEntries = this.itemTypes.spellcastingEntry;
        this.spellcasting = new ActorSpellcasting(this, spellcastingEntries);

        // Track all effects on this actor
        for (const effect of this.itemTypes.effect) {
            game.pf2e.effectTracker.register(effect);
        }

        this.prepareDataFromItems();
    }

    /** Prepare data among owned items as well as actor-data preparation performed by items */
    protected prepareDataFromItems(): void {
        for (const item of this.items) {
            item.prepareSiblingData?.();
            item.prepareActorData?.();
        }

        this.rules = this.prepareRuleElements();
    }

    protected prepareRuleElements(): RuleElementPF2e[] {
        return this.items.contents
            .flatMap((item) => item.prepareRuleElements())
            .filter((rule) => !rule.ignored)
            .sort((elementA, elementB) => elementA.priority - elementB.priority);
    }

    /** Collect all rule element output */
    protected prepareSynthetics(): void {
        // Rule elements
        for (const rule of this.rules.filter((r) => !r.ignored)) {
            try {
                rule.beforePrepareData?.();
            } catch (error) {
                // Ensure that a failing rule element does not block actor initialization
                console.error(`PF2e | Failed to execute onBeforePrepareData on rule element ${rule}.`, error);
            }
        }
    }

    /** Set traits as roll options */
    override prepareDerivedData(): void {
        const { rollOptions } = this;
        for (const trait of this.traits) {
            rollOptions.all[`self:trait:${trait}`] = true;
        }
    }

    /** Set defaults for this actor's prototype token */
    private preparePrototypeToken(): void {
        // Synchronize the token image with the actor image, if the token does not currently have an image
        const tokenImgIsDefault = [
            ActorPF2e.DEFAULT_ICON,
            `systems/pf2e/icons/default-icons/${this.type}.svg`,
        ].includes(this.prototypeToken.img);
        const tokenImgIsActorImg = this.prototypeToken.img === this.img;
        if (tokenImgIsDefault && !tokenImgIsActorImg) {
            this.prototypeToken.update({ img: this.img });
        }

        // Disable manually-configured vision settings on the prototype token
        /* if (canvas.lighting?.rulesBasedVision && ["character", "familiar"].includes(this.type)) {
            for (const property of ["brightSight", "dimSight"] as const) {
                this.prototypeToken[property] = this.prototypeToken._source[property] = 0;
            }
            this.prototypeToken.sightAngle = this.prototypeToken._source.sightAngle = 360;
        }*/

        this.prototypeToken.flags = mergeObject(
            { pf2e: { linkToActorSize: !["hazard", "loot"].includes(this.type) } },
            this.prototypeToken.flags
        );
        TokenDocumentPF2e.prepareSize(this.prototypeToken, this);
    }

    /** If there is an active encounter, set roll options for it and this actor's participant */
    setEncounterRollOptions(): void {
        const encounter = game.ready ? game.combat : null;
        const participants = encounter?.combatants.contents ?? [];
        if (!(encounter?.started && participants.some((c) => c.actor === this && typeof c.initiative === "number"))) {
            return;
        }

        const rollOptionsAll = this.rollOptions.all;
        rollOptionsAll[`encounter:round:${encounter.round}`] = true;
        rollOptionsAll[`encounter:turn:${encounter.turn + 1}`] = true;
        rollOptionsAll["self:participant:own-turn"] = encounter.combatant?.actor === this;

        const thisCombatant = participants.find((c) => c.actor === this);
        if (!thisCombatant) return;

        const rank = participants.indexOf(thisCombatant) + 1;
        rollOptionsAll[`self:participant:initiative:rank:${rank}`] = true;
    }

    /* -------------------------------------------- */
    /*  Rolls                                       */
    /* -------------------------------------------- */

    /**
     * Roll a Save Check
     * Prompt the user for input regarding Advantage/Disadvantage and any Situational Bonus.
     * @deprecated
     */
    rollSave(event: JQuery.TriggeredEvent, saveType: SaveType): void {
        console.warn("ActorPF2e#rollSaves is deprecated: use actor.saves[saveType].check.roll()");
        this.saves?.[saveType]?.check.roll(eventToRollParams(event));
    }

    /**
     * Roll a Attribute Check
     * Prompt the user for input regarding Advantage/Disadvantage and any Situational Bonus
     * @param skill {String}    The skill id
     */
    rollAttribute(event: JQuery.Event, attributeName: string) {
        if (!objectHasKey(this.system.attributes, attributeName)) {
            throw ErrorPF2e(`Unrecognized attribute "${attributeName}"`);
        }

        const attribute = this.attributes[attributeName];
        if (!(isObject(attribute) && "value" in attribute)) return;

        const parts = ["@mod", "@itemBonus"];
        const configAttributes = CONFIG.PF2E.attributes;
        if (isObject(attribute) && objectHasKey(configAttributes, attributeName)) {
            const flavor = `${game.i18n.localize(configAttributes[attributeName])} Check`;
            // Call the roll helper utility
            DicePF2e.d20Roll({
                event,
                parts,
                data: { mod: attribute.value },
                title: flavor,
                speaker: ChatMessage.getSpeaker({ actor: this }),
            });
        }
    }

    /** Toggle the provided roll option (swapping it from true to false or vice versa). */
    async toggleRollOption(domain: string, option: string, value?: boolean): Promise<boolean | null>;
    async toggleRollOption(
        domain: string,
        option: string,
        itemId: string | null,
        value?: boolean
    ): Promise<boolean | null>;
    async toggleRollOption(
        domain: string,
        option: string,
        itemId: string | boolean | null = null,
        value?: boolean
    ): Promise<boolean | null> {
        value = typeof itemId === "boolean" ? itemId : value ?? !this.rollOptions[domain]?.[option];
        if (typeof itemId === "string") {
            return RollOptionRuleElement.toggleOption({ actor: this, domain, option, itemId, value });
        } else {
            /** If no itemId is provided, attempt to find the first matching Rule Element with the exact Domain and Option. */
            const match = this.rules.find(
                (rule) => rule instanceof RollOptionRuleElement && rule.domain === domain && rule.option === option
            );

            /** If a matching item is found toggle this option. */
            const itemId = match?.item.id ?? null;
            return RollOptionRuleElement.toggleOption({ actor: this, domain, option, itemId, value });
        }
    }

    /**
     * Handle how changes to a Token attribute bar are applied to the Actor.
     *
     * If the attribute bar is for hp and the change is in delta form, defer to the applyDamage method. Otherwise, do nothing special
     * @param attribute The attribute path
     * @param value     The target attribute value
     * @param isDelta   Whether the number represents a relative change (true) or an absolute change (false)
     * @param isBar     Whether the new value is part of an attribute bar, or just a direct value
     */
    override async modifyTokenAttribute(
        attribute: string,
        value: number,
        isDelta = false,
        isBar = true
    ): Promise<this> {
        const tokens = this.getActiveTokens();
        if (attribute === "attributes.hp" && isDelta && tokens.length) {
            await this.applyDamage(-value, tokens[0]);
            return this;
        }
        return super.modifyTokenAttribute(attribute, value, isDelta, isBar);
    }

    /**
     * Apply rolled dice damage to the token or tokens which are currently controlled.
     * This allows for damage to be scaled by a multiplier to account for healing, critical hits, or resistance
     * @param damage The amount of damage inflicted
     * @param token The applicable token for this actor
     * @param shieldBlockRequest Whether the user has toggled the Shield Block button
     */
    async applyDamage(damage: number, token: TokenPF2e, shieldBlockRequest = false): Promise<void> {
        const { hitPoints } = this;
        if (!hitPoints) return;
        damage = Math.trunc(damage); // Round damage and healing (negative values) toward zero

        // Calculate damage to hit points and shield
        const translations = LocalizePF2e.translations.PF2E.Actor.ApplyDamage;
        const { attributes } = this;
        const actorShield = "shield" in attributes ? attributes.shield : null;
        const shieldBlock =
            actorShield && shieldBlockRequest
                ? ((): boolean => {
                      const warnings = LocalizePF2e.translations.PF2E.Actions.RaiseAShield;
                      if (actorShield.broken) {
                          ui.notifications.warn(
                              game.i18n.format(warnings.ShieldIsBroken, { actor: token.name, shield: actorShield.name })
                          );
                          return false;
                      } else if (actorShield.destroyed) {
                          ui.notifications.warn(
                              game.i18n.format(warnings.ShieldIsDestroyed, {
                                  actor: token.name,
                                  shield: actorShield.name,
                              })
                          );
                          return false;
                      } else if (!actorShield.raised) {
                          ui.notifications.warn(game.i18n.format(translations.ShieldNotRaised, { actor: token.name }));
                          return false;
                      } else {
                          return true;
                      }
                  })()
                : false;

        const shieldHardness = shieldBlock ? actorShield?.hardness ?? 0 : 0;
        const absorbedDamage = Math.min(shieldHardness, Math.abs(damage));
        const shieldDamage = shieldBlock ? Math.min(actorShield?.hp.value ?? 0, Math.abs(damage) - absorbedDamage) : 0;

        const hpUpdate = this.calculateHealthDelta({
            hp: hitPoints,
            sp: this.isOfType("character") ? this.attributes.sp : undefined,
            delta: damage - absorbedDamage,
        });
        const hpDamage = hpUpdate.totalApplied;

        // Make updates
        if (shieldDamage > 0) {
            const shield = (() => {
                const item = this.items.get(actorShield?.itemId ?? "");
                return item?.isOfType("armor") ? item : null;
            })();
            await shield?.update(
                { "system.hp.value": shield.hitPoints.value - shieldDamage },
                { render: hpDamage === 0 }
            );
        }
        if (hpDamage !== 0) {
            await this.update(hpUpdate.updates);
        }
        if (this.hitPoints?.value === 0) {
            const deadAtZero = game.settings.get("pf2e", "automation.actorsDeadAtZero");
            if (this.type === "npc" && ["npcsOnly", "both"].includes(deadAtZero)) {
                await game.combat?.combatants.find((c) => c.actor === this && !c.defeated)?.toggleDefeated();
            }
        }

        // Send chat message
        const hpStatement = ((): string => {
            // This would be a nested ternary, except prettier thoroughly mangles it
            if (damage === 0) return translations.TakesNoDamage;
            if (damage > 0) {
                return absorbedDamage > 0
                    ? hpDamage > 0
                        ? translations.DamagedForNShield
                        : translations.ShieldAbsorbsAll
                    : translations.DamagedForN;
            }
            return hpDamage < 0 ? translations.HealedForN : translations.AtFullHealth;
        })();

        const updatedShield = "shield" in this.attributes ? this.attributes.shield : null;
        const shieldStatement =
            updatedShield && shieldDamage > 0
                ? updatedShield.broken
                    ? translations.ShieldDamagedForNBroken
                    : updatedShield.destroyed
                    ? translations.ShieldDamagedForNDestroyed
                    : translations.ShieldDamagedForN
                : null;
        const statements = [hpStatement, shieldStatement]
            .filter((s): s is string => !!s)
            .map((s) =>
                game.i18n.format(s, { actor: token.name, hpDamage: Math.abs(hpDamage), absorbedDamage, shieldDamage })
            )
            .join(" ");

        await ChatMessagePF2e.create({
            speaker: { alias: token.name, token: token.id ?? null },
            content: `<p>${statements}</p>`,
            type: CONST.CHAT_MESSAGE_TYPES.EMOTE,
            whisper:
                game.settings.get("pf2e", "metagame.secretDamage") && !token.actor?.hasPlayerOwner
                    ? ChatMessagePF2e.getWhisperRecipients("GM").map((u) => u.id)
                    : [],
        });
    }

    isLootableBy(user: UserPF2e) {
        return this.canUserModify(user, "update");
    }

    /**
     * Moves an item to another actor's inventory.
     * @param targetActor Instance of actor to be receiving the item.
     * @param item        Instance of the item being transferred.
     * @param quantity    Number of items to move.
     * @param containerId Id of the container that will contain the item.
     * @return The target item, if the transfer is successful, or otherwise `null`.
     */
    async transferItemToActor(
        targetActor: ActorPF2e,
        item: Embedded<ItemPF2e>,
        quantity: number,
        containerId?: string,
        newStack = false
    ): Promise<Embedded<PhysicalItemPF2e> | null> {
        if (!(item instanceof PhysicalItemPF2e)) {
            throw ErrorPF2e("Only physical items (with quantities) can be transfered between actors");
        }
        const container = targetActor.inventory.get(containerId ?? "");
        if (!(!container || container instanceof ContainerPF2e)) {
            throw ErrorPF2e("containerId refers to a non-container");
        }

        // Loot transfers can be performed by non-owners when a GM is online */
        const gmMustTransfer = (source: ActorPF2e, target: ActorPF2e): boolean => {
            const bothAreOwned = source.isOwner && target.isOwner;
            const sourceIsOwnedOrLoot = source.isLootableBy(game.user);
            const targetIsOwnedOrLoot = target.isLootableBy(game.user);
            return !bothAreOwned && sourceIsOwnedOrLoot && targetIsOwnedOrLoot;
        };
        if (gmMustTransfer(this, targetActor)) {
            const source = { tokenId: this.token?.id, actorId: this.id, itemId: item.id };
            const target = { tokenId: targetActor.token?.id, actorId: targetActor.id };
            await new ItemTransfer(source, target, quantity, container?.id).request();
            return null;
        }

        if (!this.canUserModify(game.user, "update")) {
            ui.notifications.error(game.i18n.localize("PF2E.ErrorMessage.CantMoveItemSource"));
            return null;
        }
        if (!targetActor.canUserModify(game.user, "update")) {
            ui.notifications.error(game.i18n.localize("PF2E.ErrorMessage.CantMoveItemDestination"));
            return null;
        }

        // Limit the amount of items transfered to how many are actually available.
        quantity = Math.min(quantity, item.quantity);

        // Remove the item from the source if we are transferring all of it; otherwise, subtract the appropriate number.
        const newQuantity = item.quantity - quantity;
        const removeFromSource = newQuantity < 1;

        if (removeFromSource) {
            await item.delete();
        } else {
            await item.update({ "system.quantity": newQuantity });
        }

        const newItemData = item.toObject();
        newItemData.system.quantity = quantity;
        newItemData.system.equipped.carryType = "worn";
        if (hasInvestedProperty(newItemData)) {
            newItemData.system.equipped.invested = item.traits.has("invested") ? false : null;
        }

        return targetActor.addToInventory(newItemData, container, newStack);
    }

    async addToInventory(
        itemData: PhysicalItemSource,
        container?: Embedded<ContainerPF2e>,
        newStack?: boolean
    ): Promise<Embedded<PhysicalItemPF2e> | null> {
        // Stack with an existing item if possible
        const stackItem = this.findStackableItem(this, itemData);
        if (!newStack && stackItem && stackItem.type !== "backpack") {
            const stackQuantity = stackItem.quantity + itemData.data.quantity;
            await stackItem.update({ "system.quantity": stackQuantity });
            return stackItem;
        }

        // Otherwise create a new item
        const result = await ItemPF2e.create(itemData, { parent: this });
        if (!result) {
            return null;
        }
        const movedItem = this.inventory.get(result.id);
        if (!movedItem) return null;
        await this.stowOrUnstow(movedItem, container);

        return movedItem;
    }

    /** Find an item already owned by the actor that can stack with the to-be-transferred item */
    findStackableItem(actor: ActorPF2e, itemData: ItemSourcePF2e): Embedded<PhysicalItemPF2e> | null {
        const testItem = new ItemPF2e(itemData);
        const stackCandidates = actor.inventory.filter(
            (stackCandidate) =>
                !stackCandidate.isInContainer &&
                testItem instanceof PhysicalItemPF2e &&
                stackCandidate.isStackableWith(testItem)
        );
        if (stackCandidates.length === 0) {
            return null;
        } else if (stackCandidates.length > 1) {
            // Prefer stacking with unequipped items
            const notEquipped = stackCandidates.filter((item) => !item.isEquipped);
            return notEquipped.length > 0 ? notEquipped[0] : stackCandidates[0];
        } else {
            return stackCandidates[0];
        }
    }

    /**
     * Moves an item into the inventory into or out of a container.
     * @param actor       Actor whose inventory should be edited.
     * @param getItem     Lambda returning the item.
     * @param containerId Id of the container that will contain the item.
     */
    async stowOrUnstow(item: Embedded<PhysicalItemPF2e>, container?: Embedded<ContainerPF2e>): Promise<void> {
        if (!container) {
            await item.update({
                "system.containerId": null,
                "system.equipped.carryType": "worn",
                "system.equipped.handsHeld": 0,
                "system.equipped.inSlot": false,
            });
        } else if (!isCycle(item, container)) {
            const carryType = container.stowsItems ? "stowed" : "worn";
            await item.update({
                "system.containerId": container.id,
                "system.equipped.carryType": carryType,
                "system.equipped.handsHeld": 0,
                "system.equipped.inSlot": false,
            });
        }
    }

    /** Determine actor updates for applying damage/healing across temporary hit points, stamina, and then hit points */
    private calculateHealthDelta(args: {
        hp: { max: number; value: number; temp: number };
        sp?: { max: number; value: number };
        delta: number;
    }) {
        const updates: Record<string, number> = {};
        const { hp, sp, delta } = args;
        const appliedToTemp = ((): number => {
            if (!hp.temp || delta <= 0) return 0;
            const applied = Math.min(hp.temp, delta);
            updates["system.attributes.hp.temp"] = Math.max(hp.temp - applied, 0);

            return applied;
        })();

        const appliedToSP = ((): number => {
            const staminaEnabled = !!sp && game.settings.get("pf2e", "staminaVariant");
            if (!staminaEnabled || delta <= 0) return 0;
            const remaining = delta - appliedToTemp;
            const applied = Math.min(sp.value, remaining);
            updates["system.attributes.sp.value"] = Math.max(sp.value - applied, 0);

            return applied;
        })();

        const appliedToHP = ((): number => {
            const remaining = delta - appliedToTemp - appliedToSP;
            const applied = remaining > 0 ? Math.min(hp.value, remaining) : Math.max(hp.value - hp.max, remaining);
            updates["system.attributes.hp.value"] = Math.max(hp.value - applied, 0);

            return applied;
        })();
        const totalApplied = appliedToTemp + appliedToSP + appliedToHP;

        return { updates, totalApplied };
    }

    static getActionGraphics(actionType: string, actionCount?: number): { imageUrl: ImagePath; actionGlyph: string } {
        let actionImg: number | string = 0;
        if (actionType === "action") actionImg = actionCount ?? 1;
        else if (actionType === "reaction") actionImg = "reaction";
        else if (actionType === "free") actionImg = "free";
        else if (actionType === "passive") actionImg = "passive";
        const graphics: Record<string, { imageUrl: ImagePath; actionGlyph: string }> = {
            1: { imageUrl: "systems/pf2e/icons/actions/OneAction.webp", actionGlyph: "A" },
            2: { imageUrl: "systems/pf2e/icons/actions/TwoActions.webp", actionGlyph: "D" },
            3: { imageUrl: "systems/pf2e/icons/actions/ThreeActions.webp", actionGlyph: "T" },
            free: { imageUrl: "systems/pf2e/icons/actions/FreeAction.webp", actionGlyph: "F" },
            reaction: { imageUrl: "systems/pf2e/icons/actions/Reaction.webp", actionGlyph: "R" },
            passive: { imageUrl: "systems/pf2e/icons/actions/Passive.webp", actionGlyph: "" },
        };
        if (objectHasKey(graphics, actionImg)) {
            return {
                imageUrl: graphics[actionImg].imageUrl,
                actionGlyph: graphics[actionImg].actionGlyph,
            };
        } else {
            return {
                imageUrl: "systems/pf2e/icons/actions/Empty.webp",
                actionGlyph: "",
            };
        }
    }

    /**
     * Retrieve all roll option from the requested domains. Micro-optimized in an excessively verbose for-loop.
     * @param domains The domains of discourse from which to pull options. Always includes the "all" domain.
     */
    getRollOptions(domains: string[] = []): string[] {
        const withAll = Array.from(new Set(["all", ...domains]));
        const { rollOptions } = this;
        const toReturn: Set<string> = new Set();

        for (const domain of withAll) {
            for (const [option, value] of Object.entries(rollOptions[domain] ?? {})) {
                if (value) toReturn.add(option);
            }
        }

        return Array.from(toReturn).sort();
    }

    /** This allows @actor.level and such to work for roll macros */
    override getRollData(): Record<string, unknown> {
        return { ...duplicate(super.getRollData()), actor: this };
    }

    /* -------------------------------------------- */
    /* Conditions                                   */
    /* -------------------------------------------- */

    /**
     * Get a condition on this actor, returning:
     *   - the highest-valued if there are multiple of a valued condition
     *   - the longest-lasting if there are multiple of a condition with a duration
     *   - the last applied if any are present and are neither valued nor with duration
     *   - otherwise `null`
     * @param slug the slug of a core condition (subject to change when user-created conditions are introduced)
     * @param [options.all=false] return all conditions of the requested type in the order described above
     */
    getCondition(
        slug: ConditionSlug,
        { all }: { all: boolean } = { all: false }
    ): Embedded<ConditionPF2e>[] | Embedded<ConditionPF2e> | null {
        const conditions = this.itemTypes.condition
            .filter((condition) => condition.slug === slug)
            .sort((conditionA, conditionB) => {
                const [valueA, valueB] = [conditionA.value ?? 0, conditionB.value ?? 0] as const;
                const [durationA, durationB] = [conditionA.duration ?? 0, conditionB.duration ?? 0] as const;

                return valueA > valueB
                    ? 1
                    : valueB < valueB
                    ? -1
                    : durationA > durationB
                    ? 1
                    : durationA < durationB
                    ? -1
                    : 0;
            });

        return all ? conditions : conditions[0] ?? null;
    }

    /**
     * Does this actor have the provided condition?
     * @param slug The slug of the queried condition
     */
    hasCondition(slug: ConditionSlug): boolean {
        return this.itemTypes.condition.some((condition) => condition.slug === slug);
    }

    /** Decrease the value of condition or remove it entirely */
    async decreaseCondition(
        conditionSlug: ConditionSlug | Embedded<ConditionPF2e>,
        { forceRemove }: { forceRemove: boolean } = { forceRemove: false }
    ): Promise<void> {
        // Find a valid matching condition if a slug was passed
        const condition = typeof conditionSlug === "string" ? this.getCondition(conditionSlug) : conditionSlug;
        if (!condition) return;

        const value = typeof condition.value === "number" ? Math.max(condition.value - 1, 0) : null;
        if (value !== null && !forceRemove) {
            await game.pf2e.ConditionManager.updateConditionValue(condition.id, this, value);
        } else {
            await game.pf2e.ConditionManager.removeConditionFromActor(condition.id, this);
        }
    }

    /** Increase a valued condition, or create a new one if not present */
    async increaseCondition(
        conditionSlug: ConditionSlug | Embedded<ConditionPF2e>,
        { min, max = Number.MAX_SAFE_INTEGER }: { min?: number | null; max?: number | null } = {}
    ): Promise<void> {
        const existing = typeof conditionSlug === "string" ? this.getCondition(conditionSlug) : conditionSlug;
        if (existing) {
            const conditionValue = (() => {
                if (existing.value === null) return null;
                if (min && max && min > max) throw ErrorPF2e(`min (${min}) > max (${max})`);
                return min && max
                    ? Math.clamped(existing.value + 1, min, max)
                    : max
                    ? Math.min(existing.value + 1, max)
                    : existing.value + 1;
            })();
            if (conditionValue === null || conditionValue > (max ?? 0)) return;
            await game.pf2e.ConditionManager.updateConditionValue(existing.id, this, conditionValue);
        } else if (typeof conditionSlug === "string") {
            const conditionSource = game.pf2e.ConditionManager.getCondition(conditionSlug).toObject();
            const conditionValue =
                typeof conditionSource?.system.value.value === "number" && min && max
                    ? Math.clamped(conditionSource.system.value.value, min, max)
                    : null;
            conditionSource.system.value.value = conditionValue;
            await game.pf2e.ConditionManager.addConditionToActor(conditionSource, this);
        }
    }

    /** Toggle a condition as present or absent. If a valued condition is toggled on, it will be set to a value of 1. */
    async toggleCondition(conditionSlug: ConditionSlug): Promise<void> {
        if (this.hasCondition(conditionSlug)) {
            await this.decreaseCondition(conditionSlug, { forceRemove: true });
        } else {
            await this.increaseCondition(conditionSlug);
        }
    }

    /** Assess and pre-process this JSON data, ensuring it's importable and fully migrated */
    override async importFromJSON(json: string): Promise<this> {
        const processed = await preImportJSON(this, json);
        return processed ? super.importFromJSON(processed) : this;
    }

    /* -------------------------------------------- */
    /*  Event Listeners and Handlers                */
    /* -------------------------------------------- */

    protected override async _preCreate(
        data: PreDocumentId<this["data"]["_source"]>,
        options: DocumentModificationContext<this>,
        user: UserPF2e
    ): Promise<void> {
        // Set default portrait and token images
        if (this._source.img === ActorPF2e.DEFAULT_ICON) {
            this._source.img =
                this._source.prototypeToken.img =
                data.img =
                data.prototypeToken.img =
                    `systems/pf2e/icons/default-icons/${data.type}.svg`;
        }

        await super._preCreate(data, options, user);

        // Ensure imported actors are current on their schema version
        if (!options.parent) {
            await MigrationRunner.ensureSchemaVersion(this, MigrationList.constructFromVersion(this.schemaVersion));
        }
    }

    protected override async _preUpdate(
        changed: DeepPartial<this["data"]["_source"]>,
        options: ActorUpdateContext<this>,
        user: UserPF2e
    ): Promise<void> {
        // Show floaty text when applying damage or healing
        const changedHP = changed.system?.attributes?.hp;
        const currentHP = this.hitPoints;
        if (typeof changedHP?.value === "number" && currentHP) {
            const hpChange = changedHP.value - currentHP.value;
            const levelChanged = !!changed.system?.details && "level" in changed.system.details;
            if (hpChange !== 0 && !levelChanged) options.damageTaken = hpChange;
        }

        // Run preUpdateActor rule element callbacks
        type WithPreUpdateActor = RuleElementPF2e & { preUpdateActor: NonNullable<RuleElementPF2e["preUpdateActor"]> };
        const rules = this.rules.filter((r): r is WithPreUpdateActor => !!r.preUpdateActor);
        if (rules.length > 0) {
            const clone = this.clone(changed, { keepId: true });
            this.flags.pf2e.rollOptions = clone.flags.pf2e.rollOptions;
            for (const rule of rules) {
                await rule.preUpdateActor();
            }
        }

        await super._preUpdate(changed, options, user);
    }

    protected override _onUpdate(
        changed: DeepPartial<this["data"]["_source"]>,
        options: ActorUpdateContext<this>,
        userId: string
    ): void {
        super._onUpdate(changed, options, userId);
        const hideFromUser =
            !this.hasPlayerOwner && !game.user.isGM && game.settings.get("pf2e", "metagame.secretDamage");
        if (options.damageTaken && !hideFromUser) {
            const tokens = super.getActiveTokens();
            for (const token of tokens) {
                token.showFloatyText(options.damageTaken);
            }
        }

        // If alliance has changed, reprepare token data to update the color of bounding boxes
        if (canvas.ready && changed.system?.details && "alliance" in changed.system.details) {
            for (const token of this.getActiveTokens(true, true)) {
                token.prepareData();
            }
        }
    }

    /** Unregister all effects possessed by this actor */
    protected override _onDelete(options: DocumentModificationContext<this>, userId: string): void {
        for (const effect of this.itemTypes.effect) {
            game.pf2e.effectTracker.unregister(effect);
        }
        super._onDelete(options, userId);
    }

    protected override _onEmbeddedDocumentChange(embeddedName: "Item" | "ActiveEffect"): void {
        super._onEmbeddedDocumentChange(embeddedName);

        Promise.resolve().then(async () => {
            // As of at least Foundry 9.238, the `Actor` classes skips updating token effect icons on unlinked actors
            await this.token?.object?.drawEffects();
            // Foundry doesn't determine whether a token needs to be redrawn when its actor's embedded items change
            for (const tokenDoc of this.getActiveTokens(true, true)) {
                tokenDoc.onActorItemChange();
            }
        });

        // Send any accrued warnings to the console
        this.synthetics.preparationWarnings.flush();
    }
}

interface ActorPF2e extends Actor<TokenDocumentPF2e, ItemTypeMap> {
    readonly data: ActorDataPF2e;

    prototypeToken: PrototypeTokenDataPF2e;

    flags: ActorFlagsPF2e;

    _sheet: ActorSheetPF2e<this> | ActorSheet<this, ItemPF2e> | null;

    get sheet(): ActorSheetPF2e<this> | ActorSheet<this, ItemPF2e>;

    /** See implementation in class */
    createEmbeddedDocuments(
        embeddedName: "ActiveEffect",
        data: PreCreate<foundry.data.ActiveEffectSource>[],
        context?: DocumentModificationContext
    ): Promise<ActiveEffectPF2e[]>;
    createEmbeddedDocuments(
        embeddedName: "Item",
        data: PreCreate<ItemSourcePF2e>[],
        context?: DocumentModificationContext
    ): Promise<ItemPF2e[]>;
    createEmbeddedDocuments(
        embeddedName: "ActiveEffect" | "Item",
        data: PreCreate<foundry.data.ActiveEffectSource>[] | PreCreate<ItemSourcePF2e>[],
        context?: DocumentModificationContext
    ): Promise<ActiveEffectPF2e[] | ItemPF2e[]>;

    /** See implementation in class */
    updateEmbeddedDocuments(
        embeddedName: "ActiveEffect",
        updateData: EmbeddedDocumentUpdateData<ActiveEffectPF2e>[],
        options?: DocumentModificationContext
    ): Promise<ActiveEffectPF2e[]>;
    updateEmbeddedDocuments(
        embeddedName: "Item",
        updateData: EmbeddedDocumentUpdateData<ItemPF2e>[],
        options?: DocumentModificationContext
    ): Promise<ItemPF2e[]>;
    updateEmbeddedDocuments(
        embeddedName: "ActiveEffect" | "Item",
        updateData: EmbeddedDocumentUpdateData<ActiveEffectPF2e | ItemPF2e>[],
        options?: DocumentModificationContext
    ): Promise<ActiveEffectPF2e[] | ItemPF2e[]>;

    getCondition(conditionType: ConditionSlug, { all }: { all: true }): Embedded<ConditionPF2e>[];
    getCondition(conditionType: ConditionSlug, { all }: { all: false }): Embedded<ConditionPF2e> | null;
    getCondition(conditionType: ConditionSlug): Embedded<ConditionPF2e> | null;
    getCondition(
        conditionType: ConditionSlug,
        { all }: { all: boolean }
    ): Embedded<ConditionPF2e>[] | Embedded<ConditionPF2e> | null;
}

interface ActorConstructorContextPF2e extends DocumentConstructionContext<ActorPF2e> {
    pf2e?: {
        ready?: boolean;
    };
}

type ItemTypeMap = {
    [K in ItemType]: InstanceType<ConfigPF2e["PF2E"]["Item"]["documentClasses"][K]>;
};

interface HitPointsSummary {
    value: number;
    max: number;
    temp: number;
    negativeHealing: boolean;
}

interface ActorUpdateContext<T extends ActorPF2e> extends DocumentUpdateContext<T> {
    damageTaken?: number;
}

export { ActorPF2e, HitPointsSummary, ActorUpdateContext };
