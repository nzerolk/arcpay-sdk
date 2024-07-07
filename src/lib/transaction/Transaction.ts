import type {
  AppCallObject,
  AppCreateObject,
  AppDeleteObject,
  AppObject,
  PaymentObject,
  TransactionObject,
  TransfertObject
} from './types'
import { AlgodClient } from '@/lib/algod/AlgodClient'
import type { SuggestedParamsWithMinFee } from 'algosdk/dist/types/types/transactions/base'
import { TransactionType } from 'algosdk/src/types/transactions'
import algosdk, { type BoxReference } from 'algosdk'
import { base64ToArrayBuffer, encodeAppArgs, longToByteArray } from '@/utils'
import { OnApplicationComplete } from 'algosdk/src/types/transactions/base'
import type Wallet from '@/lib/wallets/Wallet'
import type { ABI } from '@/lib/contracts/abi/types'

export interface TransactionParameters {
  fromAddress: string
  appIndex?: number
  nftAppID?: number
  nftID?: number
}

export class TransactionError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'TransactionError'
  }
}

export class SimulationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SimulationError'
  }
}

type QueueMethods = '_createApp' | '_fund' | '_approve' | '_preValidate' | '_pay' | '_call'

type CreateAppArgs = [appArgs: Uint8Array[], approvalProgram: string, clearProgram: string]
type FundArgs = []
type ApproveArgs = [contractAbi: ABI, methodName: string, appIndex: number, foreignApp: number, approveArg: number]
type PreValidateArgs = [sellerAddress: string, feesAddress: string, foreignApps: number[]]
type PayArgs = [amount: number, to: string]
type CallArgs = [functionName: string, args: Uint8Array[]]

type QueueArgs =  CreateAppArgs | FundArgs | ApproveArgs | PreValidateArgs | PayArgs | CallArgs

interface QueueObject {
  method: QueueMethods,
  args: QueueArgs
}

export class Transaction {
  private readonly _objs: TransactionObject[]
  private readonly _queue: QueueObject[]
  private readonly _algod: AlgodClient
  private readonly _fromAddress: string | null
  private readonly _nftAppID: number | null
  private readonly _nftID: number | null
  private _suggestedParams: SuggestedParamsWithMinFee | null = null
  private _appIndex: number | null

  constructor(algod: AlgodClient, parameters: TransactionParameters) {
    this._algod = algod
    this._objs = []
    this._appIndex = parameters.appIndex || 0
    this._fromAddress = parameters.fromAddress
    this._nftAppID = parameters.nftAppID || null
    this._nftID = parameters.nftID || null
    this._queue = []
  }

  public createApp(appArgs: Uint8Array[], approvalProgram: string, clearProgram: string) {
    this._queue.push({ method: '_createApp', args: [ appArgs, approvalProgram, clearProgram ] })
    return this
  }

  public fund() {
    this._queue.push({ method: '_fund', args: [] })
    return this
  }

  public approve(contractAbi: ABI, methodName:string, appIndex: number = 0, foreignApp: number = 0, approveArg: number = 0) {
    this._queue.push({ method: '_approve', args: [ contractAbi, methodName, appIndex, foreignApp, approveArg ] })
    return this
  }

  public preValidate(sellerAddress: string, feesAddress: string, foreignApps: number[] = []) {
    this._queue.push({ method: '_preValidate', args: [ sellerAddress, feesAddress, foreignApps ] })
    return this
  }

  public pay(amount: number, to: string = '') {
    this._queue.push({ method: '_pay', args: [ amount, to ] })
    return this
  }

  public call(functionName: string, args: Uint8Array[] = []) {
    this._queue.push({ method: '_call', args: [ functionName, args ] })
    return this
  }

  // Sign and send transaction
  public async send(wallet: Wallet) {
    for (const obj of this._queue) {
      const method: QueueMethods = obj.method
      const args: QueueArgs = obj.args
      switch (method) {
        case '_createApp':
          await this._createApp(...args as CreateAppArgs)
          break
        case '_fund':
          await this._fund(...args as FundArgs)
          break
        case '_approve':
          await this._approve(...args as ApproveArgs)
          break
        case '_preValidate':
          await this._preValidate(...args as PreValidateArgs)
          break
        case '_pay':
          await this._pay(...args as PayArgs)
          break
        case '_call':
          await this._call(...args as CallArgs)
          break
        default:
          throw new TransactionError(`Method ${method} not implemented`)
      }
    }
    const txns = await this._getTxns()
    const signedTxns = await wallet.signTransactions(txns, true)
    return await wallet.sendRawTransactions(signedTxns)
  }

  private async _createApp(appArgs: Uint8Array[], approvalProgram: string, clearProgram: string) {
    if (!this._fromAddress) throw new TransactionError('Unable to create app: From address not set.')
    const args = [
      ...appArgs
    ]
    // Inserting nftID and nftAppID at the beginning of appArgs. Order matters!
    if (this._nftID) args.unshift(longToByteArray(this._nftID, 32))
    if (this._nftAppID) args.unshift(longToByteArray(this._nftAppID, 8))

    const suggestedParams = await this._getSuggestedParams()
    const appCreateObj: AppCreateObject = {
      type: TransactionType.appl,
      from: this._fromAddress,
      onComplete: algosdk.OnApplicationComplete.NoOpOC,
      suggestedParams,
      appArgs: args,
      approvalProgram: base64ToArrayBuffer(approvalProgram),
      clearProgram: base64ToArrayBuffer(clearProgram),
      numGlobalInts: 7,
      numGlobalByteSlices: 7,
      numLocalInts: 0,
      numLocalByteSlices: 0
    }
    this._objs.push(appCreateObj)

    this._appIndex = await this._getFutureAppIndex()
  }

  private async _fund() {
    const suggestedParams = await this._getSuggestedParams()
    if (!this._appIndex) throw new TransactionError('Unable to fund app: App index not set.')
    if (!this._fromAddress) throw new TransactionError('Unable to fund app: From address not set.')
    const appAddr = algosdk.getApplicationAddress(this._appIndex)
    const fundingAmount = 300_000
    const fundAppObj: PaymentObject = {
      type: TransactionType.pay,
      from: this._fromAddress,
      to: appAddr,
      amount: fundingAmount,
      suggestedParams
    }
    this._objs.push(fundAppObj)
  }

  private async _approve(contractAbi: ABI, methodName: string, appIndex: number, foreignApp: number, approveArg: number) {
    if (!appIndex || !foreignApp) {
      if (!this._nftAppID) throw new TransactionError('Unable to approve app: NFT app ID not set.')
      appIndex = appIndex || this._nftAppID
      foreignApp = foreignApp || this._nftAppID
    }
    if(!approveArg) {
      if (!this._nftID) throw new TransactionError('Unable to approve app: NFT ID not set.')
      approveArg = this._nftID
    }
    if (!this._appIndex) throw new TransactionError('Unable to approve app: App index not set.')
    if (!this._fromAddress) throw new TransactionError('Unable to approve app: From address not set.')
    const suggestedParams = await this._getSuggestedParams()
    const abi = new algosdk.ABIContract(contractAbi)
    const abiMethod = abi.getMethodByName(methodName)
    const appAddr = algosdk.getApplicationAddress(this._appIndex)
    const args = [appAddr, approveArg]
    const appArgsFund = encodeAppArgs(abiMethod, args)

    const appCallObj: AppCallObject = {
      type: TransactionType.appl,
      suggestedParams,
      from: this._fromAddress,
      appIndex,
      appArgs: appArgsFund,
      foreignApps: [foreignApp],
      onComplete: algosdk.OnApplicationComplete.NoOpOC
    }

    this._objs.push(appCallObj)
  }

  private async _preValidate(sellerAddress: string, feesAddress: string, foreignApps: number[]) {
    if (!this._fromAddress) throw new TransactionError('Unable to pre-validate: From address not set.')
    if (!this._appIndex) throw new TransactionError('Unable to pre-validate: App index not set.')
    if (!this._nftAppID) throw new TransactionError('Unable to pre-validate: NFT app ID not set.')
    const suggestedParams = await this._getSuggestedParams()
    const preValidateObj: AppCallObject = {
      type: TransactionType.appl,
      from: this._fromAddress,
      appIndex: this._appIndex,
      onComplete: algosdk.OnApplicationComplete.NoOpOC,
      appArgs: [new TextEncoder().encode('pre_validate')],
      accounts: [
        sellerAddress,
        feesAddress
      ],
      foreignApps: [this._nftAppID, ...foreignApps],
      suggestedParams: suggestedParams
    }
    this._objs.push(preValidateObj)
  }

  private async _pay(amount: number, to: string) {
    if (!to) {
      if (!this._appIndex) throw new TransactionError('Unable to pay: App index not set.')
      to = algosdk.getApplicationAddress(this._appIndex)
    }
    if (!this._fromAddress) throw new TransactionError('Unable to pay: From address not set.')
    const suggestedParams = await this._getSuggestedParams()
    const microAlgoAmount = amount * 1_000_000
    const payObj: PaymentObject = {
      type: TransactionType.pay,
      from: this._fromAddress,
      to,
      amount: microAlgoAmount,
      suggestedParams
    }
    this._objs.push(payObj)
  }

  private async _call(functionName: string, args: Uint8Array[]) {
    if (!this._appIndex) throw new TransactionError('Unable to call: App index not set.')
    if (!this._fromAddress) throw new TransactionError('Unable to call: From address not set.')
    const suggestedParams = await this._getSuggestedParams()
    const appArgs = [new TextEncoder().encode(functionName), ...args]
    const appCallObj: AppCallObject = {
      type: TransactionType.appl,
      from: this._fromAddress,
      appIndex: this._appIndex,
      onComplete: algosdk.OnApplicationComplete.NoOpOC,
      appArgs: appArgs,
      suggestedParams
    }
    this._objs.push(appCallObj)
  }

  private async _getTxns(): Promise<algosdk.Transaction[]> {
    const results = await this._simulateTxn()
    if (results?.txnGroups[0]?.failureMessage) {
      throw new SimulationError(results.txnGroups[0].failureMessage)
    }

    // Get accounts accessed by the app and add them to the app object
    if (results?.txnGroups[0]?.unnamedResourcesAccessed?.accounts) {
      for (const obj of this._objs) {
        if (obj.type !== TransactionType.appl) {
          continue
        }

        const appObj = obj as AppObject
        const accounts = results?.txnGroups[0].unnamedResourcesAccessed.accounts
        if (appObj.accounts) {
          appObj.accounts = Array.from(new Set([...appObj.accounts, ...accounts]))
        } else {
          appObj.accounts = accounts
        }
      }
    }

    // Get boxes accessed by the app and add them to the app object
    if (results?.txnGroups[0]?.unnamedResourcesAccessed?.boxes) {
      let boxesStart = 0
      for (const obj of this._objs) {
        if (obj.type !== TransactionType.appl) {
          continue
        }

        const appObj = obj as AppObject
        const foreignApps: Array<number> = []
        appObj.boxes = results.txnGroups[0].unnamedResourcesAccessed.boxes.map((box) => {
          if (
            box.app !== 0
            && (!('appIndex' in appObj) || box.app !== appObj?.appIndex)
            && !foreignApps.includes(box.app as number)) {
            foreignApps.push(box.app as number)
          }
          return {
            appIndex: box.app,
            name: box.name
          } as BoxReference
        })

        if (appObj.foreignApps) {
          appObj.foreignApps = Array.from(new Set([...appObj.foreignApps, ...foreignApps]))
        } else {
          appObj.foreignApps = foreignApps
        }

        if (appObj.boxes.length + (appObj.accounts?.length || 0) + appObj.foreignApps.length > 8) {
          const nextStart = boxesStart + 8 - ((appObj.accounts?.length || 0) + appObj.foreignApps.length)
          appObj.boxes = appObj.boxes.slice(boxesStart, nextStart)
          boxesStart = nextStart
        }
      }
    }
    return this._objs.map(this._getTxn)
  }

  private async _getSuggestedParams() {
    if (!this._suggestedParams) {
      this._suggestedParams = await this._algod.client.getTransactionParams().do()
    }
    return this._suggestedParams
  }

  private async _getFutureAppIndex() {
    const results = await this._simulateTxn()
    if (results?.txnGroups[0]?.failureMessage) {
      throw new SimulationError(results.txnGroups[0].failureMessage)
    }
    return results.txnGroups[0].txnResults[0].txnResult.applicationIndex as number || 0
  }

  private async _simulateTxn() {
    const txns = this._objs.map(this._getTxn)
    // Sign the transaction
    const stxns = txns.map(algosdk.encodeUnsignedSimulateTransaction)
    // Construct the simulation request
    const request = new algosdk.modelsv2.SimulateRequest({
      txnGroups: [
        new algosdk.modelsv2.SimulateRequestTransactionGroup({
          //@ts-ignore
          txns: stxns.map(algosdk.decodeObj)
        })
      ],
      allowUnnamedResources: true,
      allowEmptySignatures: true
    })

    // Simulate the transaction group
    return await this._algod.client
      .simulateTransactions(request)
      .do()
  }

  private _getTxn(obj: TransactionObject) {
    switch (obj.type) {
      case TransactionType.appl:
        if ((obj as AppCallObject).appIndex) {
          return algosdk.makeApplicationCallTxnFromObject(obj as AppCallObject)
        } else if ((obj as AppDeleteObject).onComplete === OnApplicationComplete.DeleteApplicationOC) {
          return algosdk.makeApplicationDeleteTxnFromObject(obj as AppDeleteObject)
        } else {
          return algosdk.makeApplicationCreateTxnFromObject(obj as AppCreateObject)
        }
      case TransactionType.pay:
        return algosdk.makePaymentTxnWithSuggestedParamsFromObject(obj as PaymentObject)
      case TransactionType.axfer:
        return algosdk.makeAssetTransferTxnWithSuggestedParamsFromObject(obj as TransfertObject)
      default:
        throw new TransactionError(`Transaction type ${obj.type} not implemented`)
    }
  }
}