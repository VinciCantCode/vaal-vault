import { AxiosError, AxiosResponse } from 'axios';
import axios from 'axios-observable';
import { action, autorun, computed, makeObservable, observable, runInAction } from 'mobx';
import { persist } from 'mobx-persist';
import { fromStream } from 'mobx-utils';
import { forkJoin, of, Subject, throwError, timer } from 'rxjs';
import { catchError, concatMap, map, switchMap, takeUntil } from 'rxjs/operators';
import { v4 as uuidv4 } from 'uuid';
import AppConfig from '../config/app.config';
import { ICharacter } from '../interfaces/character.interface';
import { ILeague } from '../interfaces/league.interface';
import { IOAuthResponse } from '../interfaces/oauth-response.interface';
import { IPoeProfile } from '../interfaces/poe-profile.interface';
import { IProfile } from '../interfaces/profile.interface';
import { IToken } from '../interfaces/token.interface';
import { externalService } from '../services/external.service';
import { getCharacterLeagues } from '../utils/league.utils';
import { openCustomLink } from '../utils/window.utils';
import { generateCodeVerifier, generateCodeChallenge } from '../utils/pkce.utils';
import { electronService } from './../services/electron.service';
import { Account } from './domains/account';
import { RootStore } from './rootStore';

export class AccountStore {
  @persist('list', Account) @observable accounts: Account[] = [];
  @persist @observable activeAccount: string = '';
  @persist('object') @observable token: IToken | undefined = undefined;
  @observable code: string = '';
  @observable authState: string = uuidv4();
  @observable codeVerifier: string = '';
  @observable codeChallenge: string = '';

  cancelledRetry: Subject<boolean> = new Subject();

  constructor(private rootStore: RootStore) {
    makeObservable(this);
    electronService.ipcRenderer.on('auth-callback', (_event, { code, error }) => {
      this.handleAuthCallback(code, error);
    });

    if (typeof window !== 'undefined') {
      (window as any).bypassLogin = () => {
        this.bypassLogin();
      };
    }

    // Generate initial PKCE values for fallback copy link
    this.codeVerifier = generateCodeVerifier();
    generateCodeChallenge(this.codeVerifier).then((challenge) => {
      runInAction(() => {
        this.codeChallenge = challenge;
      });
    });

    autorun(() => {
      if (this.getSelectedAccount?.activePriceLeague) {
        rootStore.uiStateStore.setSelectedPriceTableLeagueId(
          this.getSelectedAccount.activePriceLeague.id
        );
      }
    });
  }

  @computed
  get getSelectedAccount(): Account {
    const account = this.accounts.find((a) => a.uuid === this.activeAccount);
    return account ? account : new Account();
  }

  @computed
  get authUrl(): string {
    const options = {
      clientId: AppConfig.clientId,
      scopes: 'account:profile account:characters',
      redirectUrl: AppConfig.redirectUrl,
      state: this.authState,
      responseType: 'code',
    };

    return `https://www.pathofexile.com/oauth/authorize?client_id=${options.clientId}&response_type=${options.responseType}&scope=${options.scopes}&state=${options.state}&redirect_uri=${options.redirectUrl}&code_challenge=${this.codeChallenge}&code_challenge_method=S256`;
  }

  @action
  cancelRetries() {
    this.cancelledRetry.next(true);
  }

  @action
  selectAccountByName(name: string) {
    this.activeAccount = '';
    const account = this.findAccountByName(name);
    this.activeAccount = account!.uuid;
  }

  @action
  setActiveAccount(uuid: string) {
    this.activeAccount = uuid;
  }

  @action
  findAccountByName(name: string) {
    return this.accounts.find((a) => a.name === name);
  }

  @action
  addOrUpdateAccount(name: string) {
    const foundAccount = this.findAccountByName(name);

    if (foundAccount) {
      return foundAccount;
    } else {
      const newAccount = new Account({ name: name });
      this.accounts.push(newAccount);
      return newAccount;
    }
  }

  @action
  handleAuthCallback(code: string, error: string) {
    // If there is a code, proceed to get token
    if (code) {
      this.setCode(code);
      this.loginWithOAuth(code);
    } else if (error) {
      this.loginWithOAuthFail();
    }
  }

  @action
  setCode(code: string) {
    this.code = code;
  }

  @action
  async loadOAuthPage() {
    electronService.ipcRenderer.send('start-oauth-server');

    this.codeVerifier = generateCodeVerifier();
    this.codeChallenge = await generateCodeChallenge(this.codeVerifier);

    openCustomLink(this.authUrl);
  }

  @action
  loginWithOAuth(code: string) {
    electronService.ipcRenderer.send('stop-oauth-server');

    fromStream(
      externalService
        .loginWithOAuth(code, this.codeVerifier, AppConfig.clientId, AppConfig.redirectUrl)
        .pipe(
          map((res: AxiosResponse<IOAuthResponse>) => {
            this.loginWithOAuthSuccess(res.data);
          }),
          catchError((e: AxiosError) => of(this.loginWithOAuthFail(e)))
        )
    );
  }

  @action
  loginWithOAuthSuccess(response: IOAuthResponse) {
    this.rootStore.routeStore.redirect('/character');
    this.rootStore.uiStateStore.setValidated(true);
    this.rootStore.notificationStore.createNotification('login_with_oauth', 'success');
    this.setToken(response);
    // todo: implement refresh logic based on expiry
    fromStream(timer(1 * 1000).pipe(switchMap(() => of(this.initSession()))));
  }

  @action
  getPoeProfile() {
    return externalService.getProfile().pipe(
      map((profile: AxiosResponse<IPoeProfile>) => {
        this.getPoeProfileSuccess();
        return profile.data;
      }),
      catchError((e) => {
        this.getPoeProfileFail(e);
        return throwError(e);
      })
    );
  }

  @action
  getPoeProfileSuccess() {
    this.rootStore.notificationStore.createNotification('get_poe_profile', 'success');
  }

  @action
  getPoeProfileFail(e: AxiosError | Error) {
    this.rootStore.notificationStore.createNotification('get_poe_profile', 'error', true, e);

    // todo: check expiry date here
    if (!this.token) {
      this.rootStore.routeStore.redirect('/login');
    }
  }

  @action
  loginWithOAuthFail(e?: AxiosError) {
    electronService.ipcRenderer.send('stop-oauth-server');
    this.rootStore.notificationStore.createNotification('login_with_oauth', 'error', true, e);
    this.rootStore.routeStore.redirect('/login');
  }

  @action
  setToken(response: IOAuthResponse) {
    this.token = {
      accessToken: response.access_token,
      tokenType: response.token_type,
      scope: response.scope,
      expires: new Date(new Date().getTime() + +response.expires_in * 1000),
    };
    axios.defaults.headers.common['Authorization'] = `Bearer ${this.token.accessToken}`;
  }

  @action
  clearToken() {
    this.token = undefined;
    axios.defaults.headers.common['Authorization'] = '';
  }

  @action
  initSession(skipAuth?: boolean) {
    this.rootStore.uiStateStore.setStatusMessage('initializing_session');
    this.rootStore.uiStateStore.setIsInitiating(true);

    if (!this.token) {
      this.initSessionFail(new Error('error:no_token_set'));
      return this.rootStore.routeStore.redirect('/login');
    }

    if (new Date().getTime() >= new Date(this.token.expires).getTime()) {
      this.initSessionFail(new Error('error:token_expired_meta'));
      return this.rootStore.routeStore.redirect('/login', 'error:token_expired');
    }

    fromStream(
      this.getPoeProfile().pipe(
        concatMap((res: IPoeProfile) => {
          console.log('[Antigravity Debug] Poe Profile:', res);
          const account = this.addOrUpdateAccount(res.name);
          this.selectAccountByName(account.name!);

          return forkJoin(
            externalService.getLeagues('main', 1, 'poe2'),
            externalService.getCharacters('poe2'),
            !skipAuth ? this.getSelectedAccount.authorize() : of({})
          ).pipe(
            concatMap((requests) => {
              const leagues: ILeague[] = requests[0].data;
              const characters: ICharacter[] = requests[1].data.characters;
              const unsupportedLeagues = ['Path of Exile: Royale'];

              if (leagues.length === 0) {
                throw new Error('error:no_leagues');
              }
              if (characters.length === 0) {
                throw new Error('error:no_characters');
              }

              const filteredPriceLeagues = leagues.filter(
                (league) =>
                  !unsupportedLeagues.includes(league.id) && league.id.indexOf('SSF') === -1
              );
              this.rootStore.leagueStore.updateLeagues(getCharacterLeagues(characters));
              this.rootStore.leagueStore.updatePriceLeagues(filteredPriceLeagues);
              this.getSelectedAccount.updateAccountLeagues(characters);
              this.getSelectedAccount.updateLeaguesForProfiles(
                leagues.concat(getCharacterLeagues(characters)).map((l) => l.id)
              );

              const initialPriceLeagueId =
                this.getSelectedAccount.activeProfile?.activePriceLeagueId ||
                this.rootStore.leagueStore.priceLeagues[0]?.id;

              if (initialPriceLeagueId) {
                this.rootStore.priceStore.ensurePricesForLeague(initialPriceLeagueId);
              }

              return forkJoin(
                of(account.accountLeagues).pipe(
                  concatMap((leagues) => leagues),
                  concatMap((league) => {
                    this.rootStore.uiStateStore.setStatusMessage(
                      'fetching_stash_tabs',
                      league.leagueId
                    );
                    // For PoE 2, stash API is not supported/needed yet, so return an empty observable
                    return of(undefined);
                  }),
                  switchMap(() => {
                    if (this.getSelectedAccount.profiles.length === 0) {
                      const newProfile: IProfile = {
                        name: 'profile 1',
                        activeLeagueId: this.getSelectedAccount.accountLeagues[0].leagueId,
                        activePriceLeagueId: this.rootStore.leagueStore.priceLeagues[0].id,
                      };

                      const league = this.getSelectedAccount.accountLeagues.find(
                        (al) => al.leagueId === newProfile.activeLeagueId
                      );

                      if (league) {
                        runInAction(() => {
                          newProfile.activeStashTabIds = league.stashtabs
                            .slice(0, 2)
                            .map((lst) => lst.id);
                        });
                        this.rootStore.uiStateStore.setStatusMessage(
                          'creating_default_profile',
                          newProfile.name
                        );
                        return this.getSelectedAccount
                          .createProfileObservable(newProfile, () => {})
                          .pipe(
                            map(() => {
                              this.rootStore.uiStateStore.setProfilesLoaded(true);
                            })
                          );
                      }
                      return throwError(new Error('error:league_not_found'));
                    }
                    return of({});
                  })
                )
              );
            })
          );
        }),
        switchMap(() => of(this.initSessionSuccess())),
        catchError((e: AxiosError) => {
          return of(this.initSessionFail(e));
        })
      )
    );
  }

  @action
  initSessionSuccess() {
    this.rootStore.uiStateStore.resetStatusMessage();
    this.rootStore.notificationStore.createNotification('init_session', 'success');
    this.rootStore.uiStateStore.setIsInitiating(false);
    this.rootStore.uiStateStore.setInitiated(true);

    if (this.rootStore.settingStore.autoSnapshotting) {
      this.getSelectedAccount.queueSnapshot(1);
    }
  }

  @action
  initSessionFail(e: AxiosError | Error) {
    if (this.rootStore.routeStore.redirectedTo !== '/login') {
      fromStream(
        timer(45 * 1000).pipe(
          switchMap(() => of(this.initSession())),
          takeUntil(this.cancelledRetry)
        )
      );
    }

    this.rootStore.uiStateStore.resetStatusMessage();
    this.rootStore.notificationStore.createNotification('init_session', 'error', true, e);
    this.rootStore.uiStateStore.setIsInitiating(false);
    this.rootStore.uiStateStore.setInitiated(true);
  }

  @action
  validateSession(sender: string) {
    this.rootStore.uiStateStore.setValidating(true);
    this.rootStore.uiStateStore.setSubmitting(true);
    this.rootStore.uiStateStore.setStatusMessage('validating_session');
    this.validateSessionSuccess(sender);
  }

  @action
  validateSessionSuccess(sender: string) {
    this.rootStore.uiStateStore.resetStatusMessage();
    this.rootStore.notificationStore.createNotification('validate_session', 'success');
    this.rootStore.uiStateStore.setSubmitting(false);
    this.rootStore.uiStateStore.setValidating(false);
    // todo: check expiry date
    if (!this.token) {
      if (sender === '/login') {
        this.loadOAuthPage();
      } else {
        this.rootStore.routeStore.redirect('/login');
      }
    } else {
      axios.defaults.headers.common['Authorization'] = `Bearer ${this.token.accessToken}`;
      this.rootStore.uiStateStore.setValidated(true);
      this.rootStore.routeStore.redirect('/character');
      fromStream(timer(1 * 1000).pipe(switchMap(() => of(this.initSession()))));
    }
  }

  @action
  validateSessionFail(e: AxiosError | Error, sender: string) {
    if (sender !== '/login') {
      fromStream(
        timer(45 * 1000).pipe(
          switchMap(() => of(this.validateSession(sender))),
          takeUntil(this.cancelledRetry)
        )
      );
    }

    this.rootStore.uiStateStore.resetStatusMessage();
    this.rootStore.notificationStore.createNotification('validate_session', 'error', true, e);
    this.rootStore.uiStateStore.setValidating(false);
    this.rootStore.uiStateStore.setSubmitting(false);
    this.rootStore.uiStateStore.setValidated(false);
  }

  @action
  bypassLogin() {
    // 1. Create dummy account
    const dummyAccount = this.addOrUpdateAccount('VaalVaultTesterAccount');
    this.selectAccountByName('VaalVaultTesterAccount');

    // 2. Mock a character list
    const mockChar: any = {
      id: 'dummy-char-id',
      name: 'VaalVault_Ranger',
      class: 'Ranger',
      level: 92,
      experience: 2500000000,
      league: 'Standard',
      equipment: [
        {
          id: 'helmet-1',
          verified: true,
          w: 2,
          h: 2,
          ilvl: 85,
          icon:
            'https://web.poecdn.com/gen/image/WzI1LDE0LHsiZiI6IjJESXRlbXMvQXJtb3Vycy9IZWxtZXRzL0hlbG1ldExlYXRoZXIxIiwidyI6MiwiaCI6Miwic2NhbGUiOjF9XQ/05f27571b7/HelmetLeather1.png',
          league: 'Standard',
          sockets: [],
          name: 'Crown of the Pale King',
          shaper: false,
          elder: false,
          baseType: 'Hubris Circlet',
          fractured: false,
          synthesised: false,
          typeLine: 'Hubris Circlet',
          identified: true,
          corrupted: false,
          lockedToCharacter: false,
          requirements: [],
          implicitMods: ['10% increased Mana Reservation Efficiency'],
          explicitMods: [
            '+95 to maximum Life',
            '+42% to Lightning Resistance',
            '+38% to Cold Resistance',
          ],
          frameType: 3, // Unique
          x: 0,
          y: 0,
          inventoryId: 'Helmet',
          socketedItems: [
            {
              id: 'gem-1',
              verified: true,
              w: 1,
              h: 1,
              ilvl: 20,
              icon:
                'https://web.poecdn.com/gen/image/WzI1LDE0LHsiZiI6IjJESXRlbXMvR2Vtcy9BY3RpdmUvRmlyZWJhbGwiLCJ3IjoxLCJoIjoxLCJzY2FsZSI6MX1d/f4b16a24be/Fireball.png',
              name: '',
              typeLine: 'Fireball',
              corrupted: false,
              lockedToCharacter: false,
              category: { gems: ['active', 'spell'], jewels: [] },
              requirements: [],
              nextLevelRequirements: [],
              explicitMods: [],
              frameType: 0,
              x: 0,
              y: 0,
              properties: [],
              additionalProperties: [],
              descrText: '',
              secDescrText: '',
              socket: 0,
            },
            {
              id: 'gem-2',
              verified: true,
              w: 1,
              h: 1,
              ilvl: 20,
              icon:
                'https://web.poecdn.com/gen/image/WzI1LDE0LHsiZiI6IjJESXRlbXMvR2Vtcy9TdXBwb3J0L1N1cHBvcnRTcGVsbEVjaG8iLCJ3IjoxLCJoIjoxLCJzY2FsZSI6MX1d/f6b0f3408f/SupportSpellEcho.png',
              name: '',
              typeLine: 'Spell Echo Support',
              corrupted: false,
              lockedToCharacter: false,
              category: { gems: ['support', 'spell'], jewels: [] },
              requirements: [],
              nextLevelRequirements: [],
              explicitMods: [],
              frameType: 0,
              x: 0,
              y: 0,
              properties: [],
              additionalProperties: [],
              descrText: '',
              secDescrText: '',
              socket: 1,
            },
          ],
          properties: [],
          flavourText: [],
          craftedMods: [],
          enchantMods: [],
          utilityMods: [],
          descrText: '',
          prophecyText: '',
          socket: 0,
        },
        {
          id: 'weapon-1',
          verified: true,
          w: 2,
          h: 4,
          ilvl: 86,
          icon:
            'https://web.poecdn.com/gen/image/WzI1LDE0LHsiZiI6IjJESXRlbXMvV2VhcG9ucy9Ud29IYW5kV2VhcG9ucy9Cb3dzL0JvdzhVbmlxdWUiLCJ3IjoyLCJoIjo0LCJzY2FsZSI6MX1d/095de67f4c/Bow8Unique.png',
          league: 'Standard',
          sockets: [],
          name: 'Windripper',
          shaper: false,
          elder: false,
          baseType: 'Imperial Bow',
          fractured: false,
          synthesised: false,
          typeLine: 'Imperial Bow',
          identified: true,
          corrupted: false,
          lockedToCharacter: false,
          requirements: [],
          implicitMods: [],
          explicitMods: [
            'Adds 42 to 78 Cold Damage',
            'Adds 6 to 125 Lightning Damage',
            '15% increased Attack Speed',
            '15% increased Item Quantity from Frozen Enemies',
          ],
          frameType: 3, // Unique
          x: 0,
          y: 0,
          inventoryId: 'Weapon1',
          socketedItems: [],
          properties: [],
          flavourText: [],
          craftedMods: [],
          enchantMods: [],
          utilityMods: [],
          descrText: '',
          prophecyText: '',
          socket: 0,
        },
        {
          id: 'flask-1',
          verified: true,
          w: 1,
          h: 2,
          ilvl: 80,
          icon:
            'https://web.poecdn.com/gen/image/WzI1LDE0LHsiZiI6IjJESXRlbXMvRmxhc2tzL3VuaXF1ZV9kaXZpbmVfbGlmZV9mbGFzayIsInciOjEsImgiOjIsInNjYWxlIjoxfV0/14f6b31e9c/unique_divine_life_flask.png',
          league: 'Standard',
          sockets: [],
          name: 'Forbidden Taste',
          shaper: false,
          elder: false,
          baseType: 'Quartz Flask',
          fractured: false,
          synthesised: false,
          typeLine: 'Quartz Flask',
          identified: true,
          corrupted: false,
          lockedToCharacter: false,
          requirements: [],
          implicitMods: [],
          explicitMods: [
            'Recovers 95% of Life on Use',
            'You take 8% of your maximum Life as Chaos Damage per second during Effect',
          ],
          frameType: 3,
          x: 0,
          y: 0,
          inventoryId: 'Flask1',
          socketedItems: [],
          properties: [],
          flavourText: [],
          craftedMods: [],
          enchantMods: [],
          utilityMods: [],
          descrText: '',
          prophecyText: '',
          socket: 0,
        },
      ],
      passives: {
        hashes: [
          1201,
          1402,
          1603,
          1804,
          2005,
          2206,
          2407,
          2608,
          2809,
          3010,
          3211,
          3412,
          3613,
          3814,
          4015,
        ],
      },
    };

    dummyAccount.updateAccountLeagues([mockChar]);

    // 3. Set validated and mock token
    this.token = {
      accessToken: 'dummy-token',
      tokenType: 'bearer',
      scope: 'account:profile account:characters',
      expires: new Date(new Date().getTime() + 3600 * 24 * 1000),
    };
    this.rootStore.uiStateStore.setValidated(true);
    this.rootStore.uiStateStore.setProfilesLoaded(true);

    // 4. Redirect
    this.rootStore.routeStore.redirect('/character');
  }
}
